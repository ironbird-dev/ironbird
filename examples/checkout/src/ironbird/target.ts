import { createTarget, type Target } from '@ironbird/core';
import type { AppCore } from '../core/app';
import type { CheckoutEvent, CheckoutState } from '../core/checkout';
import { commands } from './commands';

export const toTarget = (app: AppCore): Target<CheckoutState> =>
  createTarget({
    commands,
    dispatch: ({ name, payload }) => app.send({ type: name, ...payload } as CheckoutEvent),
    getState: () => app.getSnapshot(),
    subscribe: (listener) => app.subscribe(listener),
  });
