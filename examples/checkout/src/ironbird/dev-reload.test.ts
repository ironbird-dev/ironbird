import { describe, expect, it, vi } from 'vitest';
import { routeDevReloads } from './dev-reload';

describe('routeDevReloads', () => {
  it('sends every DevSettings.reload, such as a Fast Refresh full reload, through the given reload', async () => {
    const original = vi.fn();
    const devSettings = { reload: original };
    const reload = vi.fn(async (_reason: string) => {});
    routeDevReloads(devSettings, reload);

    devSettings.reload('Fast Refresh - No root boundary');
    devSettings.reload();

    expect(reload.mock.calls).toEqual([['Fast Refresh - No root boundary'], ['DevSettings.reload']]);
    expect(original).not.toHaveBeenCalled();
  });

  it('reports a failed reload as a warning instead of an unhandled rejection', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const devSettings = { reload: (_reason?: string) => {} };
    routeDevReloads(devSettings, async () => {
      throw new Error('no native reload');
    });

    devSettings.reload('x');
    await new Promise((resolve) => setImmediate(resolve));

    expect(warn).toHaveBeenCalledWith('ironbird: reload failed', expect.any(Error));
    warn.mockRestore();
  });
});
