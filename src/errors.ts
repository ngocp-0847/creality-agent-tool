/**
 * Typed error taxonomy.
 *
 * Every failure surfaced by this package is a {@link CrealityError} with a
 * stable machine-readable `code`, so agents can branch on failure mode without
 * string-matching messages.
 */

export const ERROR_CODES = [
  /** Configuration or arguments are structurally invalid. */
  'CONFIG_INVALID',
  /** Target host failed SSRF / private-network validation. */
  'HOST_NOT_ALLOWED',
  /** Transport-level failure (DNS, connection refused, socket reset). */
  'NETWORK',
  /** Request exceeded its deadline. */
  'TIMEOUT',
  /** Moonraker/Klipper reported an error, or the printer is in an error state. */
  'PRINTER_ERROR',
  /** Requested resource does not exist on the printer. */
  'NOT_FOUND',
  /** G-code preflight rejected the file. */
  'PREFLIGHT_FAILED',
  /** Mutating action was attempted without a confirmation token. */
  'CONFIRMATION_REQUIRED',
  /** Confirmation token is unknown, already used, or bound to another action. */
  'CONFIRMATION_INVALID',
  /** Confirmation token is past its (short) time-to-live. */
  'CONFIRMATION_EXPIRED',
  /** The printer's current state does not permit this action. */
  'STATE_CONFLICT',
  /** Payload exceeds the configured or profile-derived size limit. */
  'PAYLOAD_TOO_LARGE',
  /** Action is not supported by this printer model / profile. */
  'UNSUPPORTED',
  /** Moonraker returned a response we could not interpret. */
  'PROTOCOL',
  /** Unexpected internal failure. */
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface CrealityErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export interface SerializedCrealityError {
  readonly name: 'CrealityError';
  readonly code: ErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

const DEFAULT_RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'NETWORK',
  'TIMEOUT',
]);

export class CrealityError extends Error {
  override readonly name = 'CrealityError';
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, message: string, options: CrealityErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.details = options.details;
  }

  toJSON(): SerializedCrealityError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }

  static is(value: unknown): value is CrealityError {
    return value instanceof CrealityError;
  }

  /** Wrap an arbitrary thrown value into a CrealityError without losing the cause. */
  static wrap(value: unknown, code: ErrorCode = 'INTERNAL', message?: string): CrealityError {
    if (value instanceof CrealityError) return value;
    const text =
      message ?? (value instanceof Error ? value.message : `Unexpected failure: ${String(value)}`);
    return new CrealityError(code, text, { cause: value });
  }
}

export const configInvalid = (message: string, details?: Record<string, unknown>): CrealityError =>
  new CrealityError('CONFIG_INVALID', message, details === undefined ? {} : { details });
