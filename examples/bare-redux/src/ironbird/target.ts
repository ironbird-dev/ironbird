import type { CommandOf, Target } from '@ironbird/core';
import { fromStore } from '@ironbird/redux';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { AppStore } from '../store/store';
import { added, renamed, toggled } from '../store/todos';
import { commands } from './commands';
import { restoreSchema } from './schema';

/** Each command dispatches the app's own action, with the payload the command schema already validated. */
export function toAction(command: CommandOf<typeof commands>): UnknownAction {
  switch (command.name) {
    case 'todos.add':
      return added(command.payload);
    case 'todos.toggle':
      return toggled(command.payload);
    case 'todos.rename':
      return renamed(command.payload);
  }
}

/** The store as an ironbird target. No `select`: agents and scenarios see the root state. */
export const toTarget = (store: AppStore): Target => fromStore(store, { commands, toAction, restore: { schema: restoreSchema } });
