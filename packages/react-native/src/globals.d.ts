declare const __DEV__: boolean | undefined;
declare const __BRIDGE_VERSION__: string | undefined;
declare const WebSocket: new (url: string) => unknown;
declare function requestAnimationFrame(callback: (time: number) => void): number;
declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
