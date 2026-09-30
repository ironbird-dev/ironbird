export const Platform = { OS: 'ios' };
// No `reload`, so the bridge doesn't declare the capability unless a test sets one.
export const DevSettings: { reload?: (reason?: string) => void } = {};
