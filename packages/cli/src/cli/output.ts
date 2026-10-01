import type { ErrorShape } from '@ironbird/core';

export interface Output {
  result(value: unknown): void;
  error(shape: ErrorShape): void;
}

export function createOutput(options: { json: boolean; write: (text: string) => void }): Output {
  const { json, write } = options;
  return {
    result(value) {
      write(json ? `${JSON.stringify(value)}\n` : `${JSON.stringify(value, null, 2)}\n`);
    },
    error(shape) {
      if (json) {
        write(`${JSON.stringify({ error: shape })}\n`);
        return;
      }
      const details = shape.details === undefined ? '' : `${JSON.stringify(shape.details, null, 2).replace(/^/gm, '  ')}\n`;
      write(`error ${shape.code}: ${shape.message}\n${details}`);
    },
  };
}

/**
 * The daemon's `result` with the envelope's `target` added when the result does not carry one,
 * which is what the CLI and the MCP server print for `state`, `reset`, and the like (docs/cli.md,
 * "Output shapes").
 */
export function withTarget(envelope: { target?: string; result: unknown }): Record<string, unknown> {
  const result = envelope.result as Record<string, unknown>;
  return envelope.target === undefined || 'target' in result ? result : { target: envelope.target, ...result };
}
