type TimerHandle = unknown;
declare function setTimeout(callback: () => void, ms?: number): TimerHandle;
declare function clearTimeout(handle: TimerHandle): void;
declare function setInterval(callback: () => void, ms?: number): TimerHandle;
declare function clearInterval(handle: TimerHandle): void;
declare const setImmediate: undefined | ((callback: () => void) => TimerHandle);
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
