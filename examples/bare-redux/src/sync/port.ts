/** What the app sends to the sync API: one to-do at one revision. */
export interface SavedTodo {
  id: string;
  title: string;
  done: boolean;
  rev: number;
}

/** The sync API's acknowledgement of one save. */
export interface SyncAck {
  id: string;
  rev: number;
}

/** The app's only way to reach the sync API. */
export interface SyncPort {
  save(todo: SavedTodo): Promise<SyncAck>;
}
