import { configureStore, type Reducer } from '@reduxjs/toolkit';
import type { SyncPort } from '../sync/port';
import { createSyncMiddleware } from './middleware';
import { createRootReducer, type AppState } from './todos';

export interface AppPorts {
  sync: SyncPort;
}

export interface AppStoreOptions {
  /** See ReducerOptions.plantBug. */
  plantBug?: boolean;
  /** Wraps the root reducer, for reducer enhancers such as persistence or state restore. */
  /** See SyncMiddlewareOptions.generation. */
  syncGeneration?: () => number;
  wrapReducer?: (reducer: Reducer<AppState>) => Reducer<AppState>;
}

export function createAppStore(ports: AppPorts, options: AppStoreOptions = {}) {
  const root = createRootReducer({ plantBug: options.plantBug });
  return configureStore({
    reducer: options.wrapReducer ? options.wrapReducer(root) : root,
    middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(createSyncMiddleware(ports.sync, { generation: options.syncGeneration })),
  });
}

export type AppStore = ReturnType<typeof createAppStore>;
export type AppDispatch = AppStore['dispatch'];
