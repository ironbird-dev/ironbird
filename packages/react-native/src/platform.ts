import { DevSettings, Platform } from 'react-native';

/** The things the bridge reads from react-native, isolated so tests can alias the module. */
export function platformOs(): string {
  return Platform.OS;
}

/**
 * `DevSettings.reload`, bound, when the runtime has it; undefined otherwise. Whether it exists is
 * what decides the `reload` capability (protocol.md §5).
 */
export function devSettingsReload(): (() => void) | undefined {
  const reload = DevSettings?.reload;
  if (typeof reload !== 'function') return undefined;
  return () => reload.call(DevSettings, 'ironbird reload');
}
