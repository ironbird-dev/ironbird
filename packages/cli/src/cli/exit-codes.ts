import type { ErrorCode, StepResult } from '@ironbird/core';

const USAGE: ReadonlySet<ErrorCode> = new Set(['AMBIGUOUS_TARGET', 'AMBIGUOUS_DEVICE', 'HEADLESS_LOAD_FAILED', 'INVALID_CONFIG', 'UNAUTHORIZED', 'PROTOCOL_MISMATCH', 'APP_MISMATCH']);
const CONDITION: ReadonlySet<ErrorCode> = new Set(['WAIT_TIMEOUT']);
const UNREACHABLE: ReadonlySet<ErrorCode> = new Set(['NO_TARGET']);

export function exitCodeForError(code: ErrorCode): 1 | 2 | 4 | 5 {
  if (USAGE.has(code)) return 2;
  if (CONDITION.has(code)) return 4;
  if (UNREACHABLE.has(code)) return 5;
  return 1;
}

export function exitCodeForStep(result: Pick<StepResult, 'settle'>): 0 | 3 {
  const settle = result.settle;
  if (!settle || settle.idle || settle.quiescent) return 0;
  return 3;
}
