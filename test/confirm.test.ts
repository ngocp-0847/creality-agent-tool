import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfirmationStore, fingerprintAction } from '../src/confirm.js';
import { CrealityError } from '../src/errors.js';

/** A store with a controllable clock and predictable tokens. */
function createStore(options: { ttlMs?: number; maxPending?: number } = {}): {
  store: ConfirmationStore;
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  let counter = 0;
  const store = new ConfirmationStore({
    ttlMs: options.ttlMs ?? 60_000,
    ...(options.maxPending === undefined ? {} : { maxPending: options.maxPending }),
    now: () => now,
    generateToken: () => {
      counter += 1;
      return `token-${counter}`;
    },
  });
  return {
    store,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

function expectError(run: () => unknown, code: string): CrealityError {
  let captured: CrealityError | undefined;
  assert.throws(run, (error: unknown) => {
    assert.ok(CrealityError.is(error), 'expected a CrealityError');
    assert.equal(error.code, code);
    captured = error;
    return true;
  });
  assert.ok(captured);
  return captured;
}

describe('fingerprintAction', () => {
  it('is stable across key ordering', () => {
    assert.equal(
      fingerprintAction('start_print', { a: 1, b: 2 }),
      fingerprintAction('start_print', { b: 2, a: 1 }),
    );
  });

  it('differs when the action differs', () => {
    assert.notEqual(
      fingerprintAction('start_print', { filename: 'a.gcode' }),
      fingerprintAction('cancel_print', { filename: 'a.gcode' }),
    );
  });

  it('differs when any parameter differs', () => {
    assert.notEqual(
      fingerprintAction('start_print', { filename: 'a.gcode' }),
      fingerprintAction('start_print', { filename: 'b.gcode' }),
    );
  });

  it('produces a hex sha256', () => {
    assert.match(fingerprintAction('pause_print', {}), /^[0-9a-f]{64}$/);
  });
});

describe('ConfirmationStore — construction', () => {
  it('rejects a non-positive TTL', () => {
    for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new ConfirmationStore({ ttlMs }),
        (error: unknown) => {
          assert.ok(CrealityError.is(error));
          assert.equal(error.code, 'CONFIG_INVALID');
          return true;
        },
      );
    }
  });
});

describe('ConfirmationStore — the happy path', () => {
  it('issues a ticket describing exactly what was authorised', () => {
    const { store } = createStore({ ttlMs: 60_000 });
    const ticket = store.issue({
      action: 'start_print',
      params: { filename: 'benchy.gcode' },
      summary: 'Start printing benchy.gcode',
    });

    assert.equal(ticket.action, 'start_print');
    assert.equal(ticket.ttlMs, 60_000);
    assert.equal(ticket.summary, 'Start printing benchy.gcode');
    assert.equal(ticket.fingerprint, fingerprintAction('start_print', { filename: 'benchy.gcode' }));
    assert.ok(ticket.token.length > 0);
    assert.match(ticket.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('accepts the token for the identical call', () => {
    const { store } = createStore();
    const ticket = store.issue({
      action: 'start_print',
      params: { filename: 'benchy.gcode' },
      summary: 'Start printing benchy.gcode',
    });
    const consumed = store.consume({
      token: ticket.token,
      action: 'start_print',
      params: { filename: 'benchy.gcode' },
    });
    assert.equal(consumed.fingerprint, ticket.fingerprint);
  });

  it('ignores parameter key ordering when redeeming', () => {
    const { store } = createStore();
    const ticket = store.issue({
      action: 'upload_gcode',
      params: { filename: 'a.gcode', sha256: 'abc', startPrint: false },
      summary: 'Upload a.gcode',
    });
    assert.doesNotThrow(() => {
      store.consume({
        token: ticket.token,
        action: 'upload_gcode',
        params: { startPrint: false, sha256: 'abc', filename: 'a.gcode' },
      });
    });
  });

  it('tolerates surrounding whitespace on the presented token', () => {
    const { store } = createStore();
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    assert.doesNotThrow(() => {
      store.consume({ token: `  ${ticket.token}  `, action: 'pause_print', params: {} });
    });
  });
});

describe('ConfirmationStore — refusals', () => {
  it('requires a token', () => {
    const { store } = createStore();
    const error = expectError(
      () => store.consume({ token: '', action: 'cancel_print', params: {} }),
      'CONFIRMATION_REQUIRED',
    );
    assert.match(error.message, /requires a confirmation token/);
  });

  it('treats whitespace as no token at all', () => {
    const { store } = createStore();
    expectError(
      () => store.consume({ token: '   ', action: 'cancel_print', params: {} }),
      'CONFIRMATION_REQUIRED',
    );
  });

  it('rejects an unknown token', () => {
    const { store } = createStore();
    expectError(
      () => store.consume({ token: 'not-a-real-token', action: 'pause_print', params: {} }),
      'CONFIRMATION_INVALID',
    );
  });

  it('makes tokens single-use', () => {
    const { store } = createStore();
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    store.consume({ token: ticket.token, action: 'pause_print', params: {} });
    const error = expectError(
      () => store.consume({ token: ticket.token, action: 'pause_print', params: {} }),
      'CONFIRMATION_INVALID',
    );
    assert.match(error.message, /already been used|single-use/);
  });

  it('refuses a token minted for a different action', () => {
    const { store } = createStore();
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    const error = expectError(
      () => store.consume({ token: ticket.token, action: 'cancel_print', params: {} }),
      'CONFIRMATION_INVALID',
    );
    assert.match(error.message, /authorises "pause_print", not "cancel_print"/);
  });

  it('refuses a token minted for different parameters', () => {
    const { store } = createStore();
    const ticket = store.issue({
      action: 'start_print',
      params: { filename: 'safe.gcode' },
      summary: 'Start printing safe.gcode',
    });
    const error = expectError(
      () =>
        store.consume({
          token: ticket.token,
          action: 'start_print',
          params: { filename: 'other.gcode' },
        }),
      'CONFIRMATION_INVALID',
    );
    assert.match(error.message, /issued for different parameters/);
  });

  it('burns a token on parameter mismatch so it cannot be retried into a match', () => {
    const { store } = createStore();
    const ticket = store.issue({
      action: 'start_print',
      params: { filename: 'safe.gcode' },
      summary: 'Start printing safe.gcode',
    });

    expectError(
      () =>
        store.consume({
          token: ticket.token,
          action: 'start_print',
          params: { filename: 'other.gcode' },
        }),
      'CONFIRMATION_INVALID',
    );

    // The correct parameters must now also fail: the token is gone.
    const retry = expectError(
      () =>
        store.consume({
          token: ticket.token,
          action: 'start_print',
          params: { filename: 'safe.gcode' },
        }),
      'CONFIRMATION_INVALID',
    );
    assert.match(retry.message, /unknown or has already been used/);
  });

  it('burns a token presented for the wrong action', () => {
    const { store } = createStore();
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    expectError(
      () => store.consume({ token: ticket.token, action: 'cancel_print', params: {} }),
      'CONFIRMATION_INVALID',
    );
    expectError(
      () => store.consume({ token: ticket.token, action: 'pause_print', params: {} }),
      'CONFIRMATION_INVALID',
    );
  });
});

describe('ConfirmationStore — expiry', () => {
  it('rejects a token past its TTL', () => {
    const { store, advance } = createStore({ ttlMs: 60_000 });
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    advance(60_001);
    expectError(
      () => store.consume({ token: ticket.token, action: 'pause_print', params: {} }),
      'CONFIRMATION_EXPIRED',
    );
  });

  it('rejects a token exactly at expiry', () => {
    const { store, advance } = createStore({ ttlMs: 60_000 });
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    advance(60_000);
    expectError(
      () => store.consume({ token: ticket.token, action: 'pause_print', params: {} }),
      'CONFIRMATION_EXPIRED',
    );
  });

  it('accepts a token just before expiry', () => {
    const { store, advance } = createStore({ ttlMs: 60_000 });
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    advance(59_999);
    assert.doesNotThrow(() => {
      store.consume({ token: ticket.token, action: 'pause_print', params: {} });
    });
  });

  it('prunes expired tickets', () => {
    const { store, advance } = createStore({ ttlMs: 10_000 });
    store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    store.issue({ action: 'resume_print', params: {}, summary: 'Resume' });
    assert.equal(store.pendingCount, 2);
    advance(10_001);
    assert.equal(store.prune(), 2);
    assert.equal(store.pendingCount, 0);
  });
});

describe('ConfirmationStore — bookkeeping', () => {
  it('evicts the oldest ticket beyond the pending cap', () => {
    const { store } = createStore({ maxPending: 2 });
    const first = store.issue({ action: 'pause_print', params: {}, summary: 'one' });
    store.issue({ action: 'pause_print', params: {}, summary: 'two' });
    store.issue({ action: 'pause_print', params: {}, summary: 'three' });

    assert.equal(store.pendingCount, 2);
    expectError(
      () => store.consume({ token: first.token, action: 'pause_print', params: {} }),
      'CONFIRMATION_INVALID',
    );
  });

  it('peeks without redeeming', () => {
    const { store } = createStore();
    const ticket = store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    assert.equal(store.peek(ticket.token)?.summary, 'Pause');
    assert.equal(store.pendingCount, 1, 'peek must not consume');
    assert.doesNotThrow(() => {
      store.consume({ token: ticket.token, action: 'pause_print', params: {} });
    });
  });

  it('returns undefined when peeking an unknown token', () => {
    const { store } = createStore();
    assert.equal(store.peek('nope'), undefined);
  });

  it('clears all outstanding tickets', () => {
    const { store } = createStore();
    store.issue({ action: 'pause_print', params: {}, summary: 'Pause' });
    store.clear();
    assert.equal(store.pendingCount, 0);
  });

  it('exposes its configured TTL', () => {
    const { store } = createStore({ ttlMs: 30_000 });
    assert.equal(store.ttlMs, 30_000);
  });

  it('mints unique tokens by default', () => {
    const store = new ConfirmationStore({ ttlMs: 60_000 });
    const tokens = new Set(
      Array.from({ length: 32 }, () =>
        store.issue({ action: 'pause_print', params: {}, summary: 'Pause' }).token,
      ),
    );
    assert.equal(tokens.size, 32);
  });
});
