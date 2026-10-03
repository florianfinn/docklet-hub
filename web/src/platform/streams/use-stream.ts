// Reads a stream store from React (#257). The store and its rules are in
// `stream-store.ts`; this file only binds it to a component.

import { useState, useSyncExternalStore } from "react";

import {
  createStreamStore,
  sharedStream,
  type StreamSnapshot,
  type StreamSource,
  type StreamStore
} from "./stream-store";

export type StreamView<TLine, TFailure> = StreamSnapshot<TLine, TFailure> & {
  /** A fresh attempt after `failed` or `closed`; meant for a button, never a timer. */
  reconnect: () => void;
};

/**
 * The stream named `key`, shared with every other reader of the same key.
 *
 * ⚠️ `source` IS READ ONCE PER KEY. A new `source` with the same key does not
 * restart anything; whatever the source depends on belongs in the key. That
 * is what keeps an inline arrow function from tearing the stream down on
 * every render.
 *
 * A new key (another container) switches to another store; the old one is
 * released once nobody reads it anymore.
 */
export function useStream<TLine, TFailure>(
  key: string,
  source: StreamSource<TLine, TFailure>,
  options: { cap: number }
): StreamView<TLine, TFailure> {
  const store = useSharedStore(key, source, options.cap);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, reconnect: store.reconnect };
}

function useSharedStore<TLine, TFailure>(
  key: string,
  source: StreamSource<TLine, TFailure>,
  cap: number
): StreamStore<TLine, TFailure> {
  // ⚠️ HELD IN STATE AND LOOKED UP AGAIN ONLY WHEN THE KEY CHANGES. A lookup
  // on every render would hand out a new store as soon as the old one was
  // released — and `useSyncExternalStore` would resubscribe on every render.
  const [held, setHeld] = useState(() => ({ key, store: acquire(key, source, cap) }));
  if (held.key === key) return held.store;
  const next = { key, store: acquire(key, source, cap) };
  setHeld(next);
  return next.store;
}

function acquire<TLine, TFailure>(
  key: string,
  source: StreamSource<TLine, TFailure>,
  cap: number
): StreamStore<TLine, TFailure> {
  return sharedStream(key, (hooks) => createStreamStore(source, { cap, ...hooks }));
}
