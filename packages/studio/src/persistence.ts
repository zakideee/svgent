export type StudioPersistence = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
};

/** Browser-local persistence with a host-controlled namespace. */
export function createLocalStoragePersistence(
  prefix: string = "svgent",
  storage?: Storage,
): StudioPersistence {
  const namespace = prefix.length === 0 ? "" : `${prefix.replace(/-+$/u, "")}-`;
  const target = (): Storage => storage ?? window.localStorage;
  return {
    getItem: (key) => target().getItem(`${namespace}${key}`),
    setItem: (key, value) => target().setItem(`${namespace}${key}`, value),
    removeItem: (key) => target().removeItem(`${namespace}${key}`),
  };
}

/**
 * Which studio writes to a persistence namespace in this document. Storage is
 * one shared drawer: two studios writing the same keys overwrite each other's
 * script, and one's factory reset deletes the other's. Every studio interested
 * in a namespace joins its queue, and the one at the head is the only writer.
 * Ownership is read, never assumed — a studio that has not joined yet does not
 * get the benefit of the doubt — and leaving the queue promotes whoever is
 * next, so the last studio standing writes again.
 *
 * The queue lives in this module, so it separates studios that share this copy
 * of the package. Two copies on one page — two bundles, two script tags — see
 * two empty queues and both write.
 */
const namespaceClaims = new Map<string, symbol[]>();
const namespaceListeners = new Set<() => void>();

function announceNamespaceChange(): void {
  for (const listener of namespaceListeners) {
    listener();
  }
}

/** Join the queue for `namespace`; the head of it is the writer. */
export function claimPersistenceNamespace(namespace: string, owner: symbol): void {
  const queue = namespaceClaims.get(namespace) ?? [];
  if (queue.includes(owner)) {
    return;
  }
  queue.push(owner);
  namespaceClaims.set(namespace, queue);
  announceNamespaceChange();
}

/** Leave the queue, promoting whoever joined next. */
export function releasePersistenceNamespace(namespace: string, owner: symbol): void {
  const queue = namespaceClaims.get(namespace);
  const at = queue?.indexOf(owner) ?? -1;
  if (queue === undefined || at === -1) {
    return;
  }
  queue.splice(at, 1);
  if (queue.length === 0) {
    namespaceClaims.delete(namespace);
  }
  announceNamespaceChange();
}

/** Whether `owner` is the one studio that may write to `namespace`. */
export function ownsPersistenceNamespace(namespace: string, owner: symbol): boolean {
  return namespaceClaims.get(namespace)?.[0] === owner;
}

/** Called whenever a studio joins or leaves any queue. */
export function subscribeToPersistenceNamespaces(listener: () => void): () => void {
  namespaceListeners.add(listener);
  return () => {
    namespaceListeners.delete(listener);
  };
}

/** The same storage, read the same way, with every write dropped. */
export function readOnlyPersistence(persistence: StudioPersistence): StudioPersistence {
  return {
    getItem: (key) => persistence.getItem(key),
    setItem: () => {},
    removeItem: () => {},
  };
}
