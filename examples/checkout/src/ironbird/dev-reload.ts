/**
 * Makes React Native's `DevSettings.reload` call `reload` instead. Fast Refresh falls back to
 * `DevSettings.reload` for a full reload whenever an edited module has no component boundary above
 * it, such as a module of plain logic. In Expo Go that reload leaves the app without its native
 * modules: it never registers again and the device target disconnects for good. Expo's
 * `reloadAppAsync` reloads cleanly, so the app reconnects running the edited code.
 */
export function routeDevReloads(devSettings: { reload(reason?: string): void }, reload: (reason: string) => Promise<void>): void {
  devSettings.reload = (reason?: string) => {
    reload(reason ?? 'DevSettings.reload').catch((error: unknown) => console.warn('ironbird: reload failed', error));
  };
}
