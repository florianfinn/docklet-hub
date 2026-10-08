import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { queryKeys } from "../../platform/query/query-keys";
import {
  fetchFileSources,
  fetchContainerShare,
  fetchFileListing,
  fetchFileText,
  fetchShareCandidates,
  removeContainerShare,
  setContainerShare
} from "./api";

// What the file tab loads, and what a write makes it load again (#263).
//
// Until #263 `FilesView` held this in two `useEffect` with a `cancelled` flag
// each and two counters (`round`, `refresh`). The three questions are queries
// now, keyed in `platform/query/query-keys.ts`; the two counters became two
// different invalidations, and the difference between them is kept:
//
// - A WRITE IN THE DIRECTORY (upload, new folder, rename, delete, saved text)
//   invalidates the listings of this container. The list on screen stays while
//   the new one loads, and with it the receipt of the upload (#136). The share
//   is not asked again: it hangs on the container, not on what the directory
//   holds.
// - CHOOSING OR RELEASING THE SHARE resets everything about this container.
//   A reset and not an invalidation: after it the old list is no answer to
//   anything, and the tab shows "loading" instead of the list of a share that
//   no longer applies.
//
// ⚠️ THE TEXT OF THE EDITOR IS NEVER CACHED. It is the base of a draft and is
// saved against the hash it came with; a cached text opened a second time
// would carry an old hash, and the first save would end in a `409` about a
// change nobody else made. Until #271 `FileEditor` loaded it in its own
// effect for that reason; `useFileText` below is a query that asks once per
// open and forgets the answer when the editor closes.

/**
 * `GET …/share`: which share is chosen for this container, or `null`.
 *
 * ⚠️ IT DOES NOT HANG ON THE PATH. The question is per (arm, container), so a
 * change of directory costs one request, the listing, and not two.
 */
export function useContainerShare(hostId: string, containerId: string) {
  return useQuery({
    queryKey: queryKeys.files.share(hostId, containerId),
    queryFn: async () => (await fetchContainerShare(hostId, containerId)).share
  });
}

/**
 * `GET …/share-candidates`, only when `enabled`.
 *
 * ⚠️ ASKED ONLY WITHOUT A SHARE, never in advance: the candidates name the bind
 * mounts of the container and with them the layout of the host. Whoever has a
 * share does not need them.
 */
export function useShareCandidates(hostId: string, containerId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.files.candidates(hostId, containerId),
    queryFn: async () => (await fetchShareCandidates(hostId, containerId)).candidates,
    enabled
  });
}

/** `GET …/files?path=…`, only when `enabled`; `""` is the root of the share. */
export function useFileListing(hostId: string, containerId: string, path: string, enabled: boolean, sourceId?: string) {
  return useQuery({
    queryKey: [...queryKeys.files.listing(hostId, containerId, path), sourceId ?? ""],
    queryFn: () => fetchFileListing(hostId, containerId, path, sourceId),
    enabled
  });
}

/**
 * After a write in a directory: load the listings of this container again.
 *
 * Every directory and not only the one on screen: a rename or a delete of a
 * folder changes what its subdirectories hold, and a cached listing of one of
 * them would show entries that no longer exist.
 */
export function useListingRefresh(hostId: string, containerId: string): () => void {
  const client = useQueryClient();
  return useCallback(() => {
    void client.invalidateQueries({ queryKey: queryKeys.files.listings(hostId, containerId) });
  }, [client, hostId, containerId]);
}

/**
 * Choosing and releasing the share. Both reset everything about this
 * container when they succeed (see the head of this file).
 *
 * ⚠️ `choose` takes the `relative` OF A CANDIDATE and nothing built here: the
 * server compares it character by character with its own candidate list and
 * answers `409 share-unknown` otherwise.
 */
export function useShareChoice(hostId: string, containerId: string) {
  const client = useQueryClient();
  const reset = () => client.resetQueries({ queryKey: queryKeys.files.container(hostId, containerId) });

  const choose = useMutation({
    mutationFn: (relative: string) => setContainerShare(hostId, containerId, relative),
    onSuccess: reset
  });
  const release = useMutation({
    mutationFn: () => removeContainerShare(hostId, containerId),
    onSuccess: reset
  });
  return { choose, release };
}

/**
 * `GET …/file-text`: the text and its hash for the editor (#271).
 *
 * ⚠️ ONCE PER OPEN AND NEVER FROM THE CACHE. `staleTime: Infinity` keeps a
 * mounted editor from asking again behind its draft; `gcTime: 0` drops the
 * answer as soon as the editor closes, so the next open asks the arm and
 * carries the hash of now. "Reload and discard" is a new `round`, a new key.
 * No retry: the read writes an audit entry at the arm, and the editor showed a
 * failure at once before it became a query.
 */
export function useFileText(hostId: string, containerId: string, path: string, round: number, sourceId?: string) {
  return useQuery({
    queryKey: [...queryKeys.files.text(hostId, containerId, path, round), sourceId ?? ""],
    queryFn: async () => (await fetchFileText(hostId, containerId, path, sourceId)).text,
    staleTime: Infinity,
    gcTime: 0,
    retry: false
  });
}

export function useFileSources(hostId: string, containerId: string) {
  return useQuery({ queryKey: [...queryKeys.files.container(hostId, containerId), "sources"],
    queryFn: () => fetchFileSources(hostId, containerId), retry: false });
}
