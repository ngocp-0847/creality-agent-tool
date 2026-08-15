import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULTS, ENV_KEYS, defineConfig, loadConfigFromEnv } from '../src/config.js';
import { CrealityError } from '../src/errors.js';
import { PRINTER_PROFILES } from '../src/profiles.js';

function expectConfigInvalid(run: () => unknown, pattern: RegExp): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(CrealityError.is(error), 'expected a CrealityError');
    assert.equal(error.code, 'CONFIG_INVALID');
    assert.match(error.message, pattern);
    return true;
  });
}

describe('defineConfig', () => {
  it('applies documented defaults', () => {
    const config = defineConfig({ baseUrl: 'http://192.168.1.42:7125', model: 'k1' });
    assert.equal(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs);
    assert.equal(config.uploadTimeoutMs, DEFAULTS.uploadTimeoutMs);
    assert.equal(config.confirmationTtlMs, DEFAULTS.confirmationTtlMs);
    assert.equal(config.maxUploadBytes, DEFAULTS.maxUploadBytes);
  });

  it('defaults to the safe end of every security switch', () => {
    const config = defineConfig({ baseUrl: 'http://192.168.1.42:7125', model: 'k1' });
    assert.equal(config.allowPublicNetwork, false, 'public network must be opt-in');
    assert.deepEqual(config.allowedHosts, []);
  });

  it('normalises the model and trims trailing slashes from the base URL', () => {
    const config = defineConfig({ baseUrl: 'http://printer.local:7125///', model: 'K1 Max' });
    assert.equal(config.model, 'k1-max');
    assert.equal(config.baseUrl, 'http://printer.local:7125');
  });

  it('clamps maxUploadBytes down to the profile ceiling', () => {
    const config = defineConfig({
      baseUrl: 'http://192.168.1.42:7125',
      model: 'k1',
      maxUploadBytes: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(config.maxUploadBytes, PRINTER_PROFILES.k1.maxGcodeBytes);
  });

  it('keeps a caller-supplied limit below the profile ceiling', () => {
    const config = defineConfig({
      baseUrl: 'http://192.168.1.42:7125',
      model: 'k1',
      maxUploadBytes: 4096,
    });
    assert.equal(config.maxUploadBytes, 4096);
  });

  it('omits an empty API key rather than sending a blank header', () => {
    const config = defineConfig({ baseUrl: 'http://192.168.1.42:7125', model: 'k1', apiKey: '  ' });
    assert.equal('apiKey' in config, false);
  });

  it('trims a supplied API key', () => {
    const config = defineConfig({
      baseUrl: 'http://192.168.1.42:7125',
      model: 'k1',
      apiKey: '  secret  ',
    });
    assert.equal(config.apiKey, 'secret');
  });

  it('rejects a missing base URL', () => {
    expectConfigInvalid(() => defineConfig({ baseUrl: '   ', model: 'k1' }), /baseUrl is required/);
  });

  it('rejects out-of-range timeouts', () => {
    expectConfigInvalid(
      () => defineConfig({ baseUrl: 'http://x:7125', model: 'k1', requestTimeoutMs: 10 }),
      /requestTimeoutMs must be an integer/,
    );
    expectConfigInvalid(
      () => defineConfig({ baseUrl: 'http://x:7125', model: 'k1', uploadTimeoutMs: 10_000_000 }),
      /uploadTimeoutMs must be an integer/,
    );
  });

  it('rejects a confirmation TTL outside the safe window', () => {
    expectConfigInvalid(
      () => defineConfig({ baseUrl: 'http://x:7125', model: 'k1', confirmationTtlMs: 1000 }),
      /confirmationTtlMs must be an integer/,
    );
    expectConfigInvalid(
      () => defineConfig({ baseUrl: 'http://x:7125', model: 'k1', confirmationTtlMs: 3_600_000 }),
      /confirmationTtlMs must be an integer/,
    );
  });
});

describe('loadConfigFromEnv', () => {
  const base = {
    [ENV_KEYS.baseUrl]: 'http://192.168.1.42:7125',
    [ENV_KEYS.model]: 'k1c',
  } as const;

  it('reads a minimal environment', () => {
    const config = loadConfigFromEnv({ ...base });
    assert.equal(config.baseUrl, 'http://192.168.1.42:7125');
    assert.equal(config.model, 'k1c');
    assert.equal(config.dryRunDefault, false);
    assert.equal(config.allowPublicNetwork, false);
  });

  it('requires the printer URL', () => {
    expectConfigInvalid(
      () => loadConfigFromEnv({ [ENV_KEYS.model]: 'k1' }),
      new RegExp(`${ENV_KEYS.baseUrl} is required`),
    );
  });

  it('requires the printer model', () => {
    expectConfigInvalid(
      () => loadConfigFromEnv({ [ENV_KEYS.baseUrl]: 'http://192.168.1.42:7125' }),
      new RegExp(`${ENV_KEYS.model} is required`),
    );
  });

  it('parses every accepted boolean spelling', () => {
    for (const truthy of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      const config = loadConfigFromEnv({ ...base, [ENV_KEYS.dryRunDefault]: truthy });
      assert.equal(config.dryRunDefault, true, `expected "${truthy}" to be true`);
    }
    for (const falsy of ['0', 'false', 'no', 'off', 'OFF']) {
      const config = loadConfigFromEnv({ ...base, [ENV_KEYS.dryRunDefault]: falsy });
      assert.equal(config.dryRunDefault, false, `expected "${falsy}" to be false`);
    }
  });

  it('rejects a non-boolean flag rather than guessing', () => {
    expectConfigInvalid(
      () => loadConfigFromEnv({ ...base, [ENV_KEYS.allowPublicNetwork]: 'maybe' }),
      /must be a boolean/,
    );
  });

  it('rejects a non-integer timeout', () => {
    expectConfigInvalid(
      () => loadConfigFromEnv({ ...base, [ENV_KEYS.requestTimeoutMs]: 'soon' }),
      new RegExp(`${ENV_KEYS.requestTimeoutMs} must be an integer`),
    );
  });

  it('splits, trims and lowercases the host allowlist', () => {
    const config = loadConfigFromEnv({
      ...base,
      [ENV_KEYS.allowedHosts]: ' Printer.local , 192.168.1.42 ,, ',
    });
    assert.deepEqual(config.allowedHosts, ['printer.local', '192.168.1.42']);
  });

  it('carries the audit log path and API key through', () => {
    const config = loadConfigFromEnv({
      ...base,
      [ENV_KEYS.apiKey]: 'abc123',
      [ENV_KEYS.auditLogPath]: '/var/log/creality.jsonl',
    });
    assert.equal(config.apiKey, 'abc123');
    assert.equal(config.auditLogPath, '/var/log/creality.jsonl');
  });

  it('treats an empty numeric variable as unset', () => {
    const config = loadConfigFromEnv({ ...base, [ENV_KEYS.requestTimeoutMs]: '' });
    assert.equal(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs);
  });
});
