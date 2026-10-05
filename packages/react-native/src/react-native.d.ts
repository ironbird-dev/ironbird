declare module 'react-native' {
  export const Platform: { readonly OS: string };
  /** `reload` exists in React Native's JavaScript API; it restarts the app's JavaScript from the bundler in a dev build. */
  export const DevSettings: { reload?: (reason?: string) => void };
}
