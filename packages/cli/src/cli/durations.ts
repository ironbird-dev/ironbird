export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m)?$/;
const MULTIPLIER: Record<string, number> = { ms: 1, s: 1_000, m: 60_000 };

export function parseDuration(input: string): number {
  const match = DURATION.exec(input);
  if (!match) throw new UsageError(`Invalid duration "${input}"; use a number with an optional ms, s, or m suffix`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 'ms';
  return Math.round(amount * (MULTIPLIER[unit] ?? 1));
}
