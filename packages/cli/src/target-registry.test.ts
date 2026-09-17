import { describe, expect, it } from 'vitest';
import { createTargetRegistry } from './target-registry';

describe('createTargetRegistry', () => {
  it('assigns ids per platform in connection order', () => {
    const registry = createTargetRegistry();
    expect(registry.claim('ios')).toBe('ios');
    expect(registry.claim('ios')).toBe('ios-2');
    expect(registry.claim('android')).toBe('android');
    expect(registry.claim('ios')).toBe('ios-3');
    expect(registry.claim('android')).toBe('android-2');
  });

  it('reserves a released id and hands the lowest one back first', () => {
    const registry = createTargetRegistry();
    registry.claim('ios');
    registry.claim('ios');
    registry.claim('ios');
    registry.release('ios-2');
    registry.release('ios');
    // A Metro reload keeps --target ios working: the next hello takes the lowest reserved id.
    expect(registry.claim('ios')).toBe('ios');
    expect(registry.claim('ios')).toBe('ios-2');
    expect(registry.claim('ios')).toBe('ios-4');
  });

  it('ignores a release of an unknown id', () => {
    const registry = createTargetRegistry();
    registry.release('nope');
    expect(registry.claim('android')).toBe('android');
  });
});
