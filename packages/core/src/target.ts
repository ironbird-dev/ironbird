import { IronbirdError, isIronbirdError, messageOf } from './errors';
import type { CommandOf, CommandRegistry } from './registry';

export interface TargetDefinition<R extends CommandRegistry, S> {
  commands: R;
  dispatch(command: CommandOf<R>): void | Promise<void>;
  getState(): S;
  subscribe?(listener: () => void): () => void;
  persist?(): unknown;
  restore?(snapshot: unknown): void | Promise<void>;
}

export interface Target<S = unknown> {
  readonly commands: CommandRegistry;
  readonly capabilities: ReadonlyArray<'persist' | 'restore'>;
  /** Validates with the registry, then calls definition.dispatch with the parsed payload. */
  dispatch(name: string, payload?: unknown): Promise<void>;
  getState(): S;
  /** Increments on every subscribe notification, or on every dispatch when subscribe is absent. */
  revision(): number;
  subscribe(listener: () => void): () => void;
  persist?(): unknown;
  restore?(snapshot: unknown): Promise<void>;
}

export function createTarget<R extends CommandRegistry, S>(definition: TargetDefinition<R, S>): Target<S> {
  const registry: CommandRegistry = definition.commands;
  const listeners = new Set<() => void>();
  let rev = 0;
  const bump = (): void => {
    rev += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch (error) {
        console.warn(`ironbird: a target subscriber threw and was skipped: ${messageOf(error)}`);
      }
    }
  };
  const hasSubscribe = typeof definition.subscribe === 'function';
  if (definition.subscribe) definition.subscribe(bump);

  const capabilities: Array<'persist' | 'restore'> = [];
  if (definition.persist) capabilities.push('persist');
  if (definition.restore) capabilities.push('restore');

  const target: Target<S> = {
    commands: registry,
    capabilities,
    async dispatch(name, payload) {
      const parsed = registry.parse(name, payload);
      try {
        await definition.dispatch({ name, payload: parsed } as CommandOf<R>);
      } catch (error) {
        const message = messageOf(error);
        throw new IronbirdError('DISPATCH_FAILED', `Dispatch of ${name} failed: ${message}`, { name, message });
      }
      if (!hasSubscribe) bump();
    },
    getState: () => definition.getState(),
    revision: () => rev,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  // A definition's own IronbirdError passes through (the adapters throw INVALID_SNAPSHOT with the
  // path that failed validation); anything else is the snapshot's problem, not ironbird's, so it
  // becomes INVALID_SNAPSHOT rather than INTERNAL (M5 design §4).
  const snapshotError = (verb: 'saved' | 'restored', error: unknown): IronbirdError => {
    if (isIronbirdError(error)) return error as IronbirdError;
    const reason = messageOf(error);
    return new IronbirdError('INVALID_SNAPSHOT', `Snapshot could not be ${verb}: ${reason}`, { path: '', reason });
  };

  if (definition.persist) {
    const persist = definition.persist;
    target.persist = () => {
      try {
        return persist();
      } catch (error) {
        throw snapshotError('saved', error);
      }
    };
  }
  if (definition.restore) {
    const restore = definition.restore;
    target.restore = async (snapshot) => {
      try {
        await restore(snapshot);
      } catch (error) {
        throw snapshotError('restored', error);
      }
      if (!hasSubscribe) bump();
    };
  }
  return target;
}
