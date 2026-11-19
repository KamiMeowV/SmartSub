import fs from 'node:fs';

/** The part of electron-store (conf) that the cache relies on. */
interface ReadableStore {
  readonly path: string;
  get(...args: unknown[]): unknown;
  has(...args: unknown[]): boolean;
}

function findAccessor(target: object, key: string) {
  for (
    let prototype = Object.getPrototypeOf(target);
    prototype;
    prototype = Object.getPrototypeOf(prototype)
  ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor) return descriptor;
  }
  return undefined;
}

/** conf hands out a fresh object with a null prototype; keep that shape. */
function cloneRecord(record: Record<string, unknown>) {
  return Object.assign(Object.create(null), structuredClone({ ...record }));
}

/**
 * conf (under electron-store 8) reads and parses the whole file on every
 * `get`/`has`. The file holds every task's file projections, so with hundreds of
 * files each read of a single setting parsed megabytes on the main thread.
 *
 * Reads now use a parsed snapshot, and callers still get their own copy of the
 * value they asked for. Every write through the store drops the snapshot before
 * conf writes the file, so `onDidChange` listeners and later reads see what was
 * written. A file replaced behind the store's back (task data migration, manual
 * edits) is noticed by its changed identity on the next read.
 */
export function cacheStoreReads<T extends ReadableStore>(store: T): T {
  const accessor = findAccessor(store, 'store');
  const readFile = accessor?.get;
  const writeFile = accessor?.set;
  if (
    !readFile ||
    !writeFile ||
    typeof store.get !== 'function' ||
    typeof store.has !== 'function'
  )
    return store;

  let snapshot: Record<string, unknown> | undefined;
  let identity: string | undefined;
  /** Set while conf's own get/has read the snapshot without copying it. */
  let lending = 0;
  /**
   * conf's set/delete start by reading the whole store, change one key and write it
   * back. That one read may share the snapshot's values: whatever happens next, the
   * snapshot is dropped before anyone else reads it.
   */
  let shareNextRead = false;
  const fileIdentity = () => {
    try {
      const stat = fs.statSync(store.path, { bigint: true });
      return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch {
      return '';
    }
  };
  const current = () => {
    // Identify before reading: a write that lands during the read is caught next time.
    const now = fileIdentity();
    if (snapshot === undefined || now !== identity) {
      snapshot = readFile.call(store) as Record<string, unknown>;
      identity = now;
    }
    return snapshot;
  };

  Object.defineProperty(store, 'store', {
    configurable: true,
    enumerable: false,
    get() {
      const data = current();
      if (lending) return data;
      if (shareNextRead) {
        shareNextRead = false;
        return Object.assign(Object.create(null), data);
      }
      return cloneRecord(data);
    },
    set(value: unknown) {
      // conf validates, writes and then emits 'change' within this call; listeners
      // and every later read must load what was just written.
      snapshot = undefined;
      identity = undefined;
      writeFile.call(store, value);
    },
  });

  const lend =
    <R>(method: (...args: unknown[]) => R) =>
    (target: unknown, args: unknown[]): R => {
      lending++;
      try {
        return method.apply(target, args);
      } finally {
        lending--;
      }
    };
  const target: ReadableStore = store;
  const get = lend(target.get);
  const has = lend(target.has);
  target.get = function (this: unknown, ...args: unknown[]) {
    const value = get(this, args);
    // A missing key answers with the caller's own default, exactly as before.
    if (value === null || typeof value !== 'object' || value === args[1])
      return value;
    return value === snapshot
      ? cloneRecord(value as Record<string, unknown>)
      : structuredClone(value);
  };
  target.has = function (this: unknown, ...args: unknown[]) {
    return has(this, args);
  };
  for (const name of ['set', 'delete'] as const) {
    const write = (store as unknown as Record<string, Function>)[name];
    if (typeof write !== 'function') continue;
    (store as unknown as Record<string, Function>)[name] = function (
      this: unknown,
      ...args: unknown[]
    ) {
      shareNextRead = true;
      try {
        return write.apply(this, args);
      } finally {
        // Also after a rejected value: conf may have changed the shared copy.
        shareNextRead = false;
        snapshot = undefined;
        identity = undefined;
      }
    };
  }
  return store;
}
