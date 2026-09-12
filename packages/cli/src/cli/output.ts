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
