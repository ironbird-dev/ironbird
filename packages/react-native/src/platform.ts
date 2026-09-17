import { Platform } from 'react-native';

/** The one thing the bridge reads from react-native, isolated so tests can alias the module. */
export function platformOs(): string {
  return Platform.OS;
}
