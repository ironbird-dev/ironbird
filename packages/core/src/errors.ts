import type { ErrorShape } from './protocol';

export const ERROR_CODES = [
  'UNKNOWN_COMMAND',
  'INVALID_PAYLOAD',
  'DISPATCH_FAILED',
  'UNKNOWN_FAKE',
  'UNKNOWN_CONTROL',
  'WAIT_TIMEOUT',
  'UNSUPPORTED',
  'NO_TARGET',
  'AMBIGUOUS_TARGET',
  'TARGET_DISCONNECTED',
  'AMBIGUOUS_DEVICE',
  'SCREENSHOT_FAILED',
  'HEADLESS_LOAD_FAILED',
  'INVALID_CONFIG',
  'CLOCK_RUNAWAY',
  'PROTOCOL_MISMATCH',
  'APP_MISMATCH',
  'UNAUTHORIZED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const PROTOCOL_VERSION = 1 as const;

export class IronbirdError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'IronbirdError';
    this.code = code;
    this.details = details;
  }

  toJSON(): ErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isIronbirdError(value: unknown): value is IronbirdError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; code?: unknown; message?: unknown };
  return candidate.name === 'IronbirdError' && typeof candidate.code === 'string' && typeof candidate.message === 'string';
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function toErrorShape(error: unknown): ErrorShape {
  if (isIronbirdError(error)) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  const message = messageOf(error);
  return { code: 'INTERNAL', message, details: { message } };
}
