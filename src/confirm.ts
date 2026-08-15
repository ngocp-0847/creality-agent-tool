/**
 * Two-phase confirmation for mutating actions.
 *
 * The premise: an agent may *propose* a physical action, but a human decides
 * whether it happens. `issue()` returns a short-lived, single-use ticket bound to
 * the exact action *and its exact parameters*; `consume()` will only accept that
 * ticket for the identical call.
 *
 * Consequences of that binding, all deliberate:
 *   - A token for `start_print(a.gcode)` cannot start `b.gcode`.
 *   - A token for an upload is bound to the content digest, so the bytes cannot
 *     be swapped between confirmation and execution.
 *   - Tokens expire in minutes, not hours: a confirmation is a here-and-now
 *     intent, not a standing grant.
 *   - A token presented with the wrong parameters is *burned*, not merely
 *     rejected, so a mismatch cannot be retried into a match.
 */

import { randomBytes } from 'node:crypto';

import { CrealityError } from './errors.js';
import { canonicalJson, sha256Hex } from './hash.js';
import type { ConfirmationTicket, MutatingAction } from './types.js';

export interface IssueConfirmationInput {
  readonly action: MutatingAction;
  /** Exactly the parameters the eventual call will use. */
  readonly params: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

export interface ConsumeConfirmationInput {
  readonly token: string;
  readonly action: MutatingAction;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ConfirmationStoreOptions {
  readonly ttlMs: number;
  /** Bound on outstanding tickets; the oldest are evicted beyond it. */
  readonly maxPending?: number;
  readonly now?: () => number;
  readonly generateToken?: () => string;
}

const DEFAULT_MAX_PENDING = 64;
const TOKEN_BYTES = 24;

interface PendingTicket {
  readonly ticket: ConfirmationTicket;
  readonly expiresAtMs: number;
  readonly issuedAtMs: number;
}

/** Stable digest of "which action, with which arguments". */
export function fingerprintAction(
  action: string,
  params: Readonly<Record<string, unknown>>,
): string {
  return sha256Hex(canonicalJson({ action, params }));
}

export class ConfirmationStore {
  readonly #ttlMs: number;
  readonly #maxPending: number;
  readonly #now: () => number;
  readonly #generateToken: () => string;
  readonly #pending = new Map<string, PendingTicket>();

  constructor(options: ConfirmationStoreOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new CrealityError('CONFIG_INVALID', 'Confirmation TTL must be a positive number.');
    }
    this.#ttlMs = options.ttlMs;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    this.#now = options.now ?? Date.now;
    this.#generateToken =
      options.generateToken ?? ((): string => randomBytes(TOKEN_BYTES).toString('base64url'));
  }

  get ttlMs(): number {
    return this.#ttlMs;
  }

  get pendingCount(): number {
    this.prune();
    return this.#pending.size;
  }

  /** Mint a ticket authorising exactly this action with exactly these parameters. */
  issue(input: IssueConfirmationInput): ConfirmationTicket {
    this.prune();

    const issuedAtMs = this.#now();
    const expiresAtMs = issuedAtMs + this.#ttlMs;
    const token = this.#generateToken();
    if (this.#pending.has(token)) {
      throw new CrealityError('INTERNAL', 'Confirmation token collision; retry the request.');
    }

    const ticket: ConfirmationTicket = {
      token,
      action: input.action,
      expiresAt: new Date(expiresAtMs).toISOString(),
      ttlMs: this.#ttlMs,
      fingerprint: fingerprintAction(input.action, input.params),
      summary: input.summary,
    };

    this.#pending.set(token, { ticket, expiresAtMs, issuedAtMs });

    // Evict oldest-first if an agent has been minting tickets it never uses.
    while (this.#pending.size > this.#maxPending) {
      const oldest = this.#pending.keys().next();
      if (oldest.done === true) break;
      this.#pending.delete(oldest.value);
    }

    return ticket;
  }

  /**
   * Redeem a ticket. Returns it on success; throws `CONFIRMATION_INVALID` or
   * `CONFIRMATION_EXPIRED` otherwise. The ticket is removed either way.
   */
  consume(input: ConsumeConfirmationInput): ConfirmationTicket {
    const token = typeof input.token === 'string' ? input.token.trim() : '';
    if (token === '') {
      throw new CrealityError(
        'CONFIRMATION_REQUIRED',
        `Action "${input.action}" requires a confirmation token. ` +
          'Request one first, show the plan to a human, then retry with the token.',
        { details: { action: input.action } },
      );
    }

    const entry = this.#pending.get(token);
    if (entry === undefined) {
      throw new CrealityError(
        'CONFIRMATION_INVALID',
        'Confirmation token is unknown or has already been used. Tokens are single-use.',
        { details: { action: input.action } },
      );
    }

    // Burn on any mismatch: a rejected token must never be retryable.
    this.#pending.delete(token);

    if (this.#now() >= entry.expiresAtMs) {
      throw new CrealityError(
        'CONFIRMATION_EXPIRED',
        `Confirmation token expired at ${entry.ticket.expiresAt}. Request a fresh one.`,
        { details: { action: input.action, expiresAt: entry.ticket.expiresAt } },
      );
    }

    if (entry.ticket.action !== input.action) {
      throw new CrealityError(
        'CONFIRMATION_INVALID',
        `Confirmation token authorises "${entry.ticket.action}", not "${input.action}". Token discarded.`,
        { details: { expected: entry.ticket.action, received: input.action } },
      );
    }

    const fingerprint = fingerprintAction(input.action, input.params);
    if (fingerprint !== entry.ticket.fingerprint) {
      throw new CrealityError(
        'CONFIRMATION_INVALID',
        `Confirmation token was issued for different parameters (confirmed: ${entry.ticket.summary}). ` +
          'Token discarded; request a new confirmation for the parameters you intend to use.',
        {
          details: {
            action: input.action,
            confirmedSummary: entry.ticket.summary,
            expectedFingerprint: entry.ticket.fingerprint,
            receivedFingerprint: fingerprint,
          },
        },
      );
    }

    return entry.ticket;
  }

  /** Inspect a ticket without redeeming it. Returns undefined if absent or expired. */
  peek(token: string): ConfirmationTicket | undefined {
    this.prune();
    return this.#pending.get(token)?.ticket;
  }

  prune(): number {
    const now = this.#now();
    let removed = 0;
    for (const [token, entry] of this.#pending) {
      if (now >= entry.expiresAtMs) {
        this.#pending.delete(token);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.#pending.clear();
  }
}
