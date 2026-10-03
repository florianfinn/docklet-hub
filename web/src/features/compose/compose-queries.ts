import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import { queryKeys } from "../../platform/query/query-keys";
import {
  fetchCompose,
  fetchComposeCandidates,
  fetchProjectEnv,
  previewCompose,
  type ComposeFile,
  type ProjectEnv
} from "./api";
import { isComposeFileMissing, searchedDir, selectionOffered } from "./compose-errors";

// What the compose tab loads (#265).
//
// Until #265 `ComposeView`, `EnvView` and `ComposeApply` each loaded in a
// `useEffect` with a `cancelled` flag, and the view kept two counters (`round`,
// `revision`) in the string it compared the answer against. The three reads are
// queries now, keyed in `platform/query/query-keys.ts`.
//
// ⚠️ ALL THREE ARE ASKED ONCE PER OPENING, NEVER AGAIN BY THEMSELVES, and that
// is the whole reason for the options below:
//
// - `staleTime: Infinity`: every read here writes an entry into the audit log
//   of the arm (`openContainerAccess` on the server). A background refetch on
//   mount or on a new observer would write one nobody asked for.
// - `gcTime: 0`: an answer is dropped with the last view that shows it. The
//   tab is a fresh question each time it is opened, as it was with the effects;
//   a cached file would be shown with an old hash and the first apply would end
//   in `datei-fremd-geaendert`. For the `.env` and the draft it also keeps
//   what the arm holds out of the cache of the page.
//
// Asking again is explicit: `useComposeFileReload`.

const ONCE_PER_OPENING = { staleTime: Infinity, gcTime: 0 } as const;

/**
 * The lookup found no file through any candidate, or failed on one.
 *
 * It carries the error of the failing (last) candidate untouched, so
 * `composeErrorKey` still reads status, code and reason from it, and the
 * directories the arm searched (#183).
 */
export class ComposeLookupError extends Error {
  readonly error: unknown;
  /** Where the arm looked, one entry per candidate without a file, no duplicates. */
  readonly searched: string[];
  /** The containers without a file, in the order of the walk (#185). */
  readonly skipped: string[];
  /** Whether the hub offers the selection by hand for them (#185). */
  readonly offered: boolean;

  constructor(error: unknown, walk: ComposeWalk) {
    super("compose lookup failed");
    this.name = "ComposeLookupError";
    this.error = error;
    this.searched = walk.searched;
    this.skipped = walk.skipped;
    this.offered = walk.offered;
  }
}

/** What the walk learns on the way about the containers it skipped. */
type ComposeWalk = { searched: string[]; skipped: string[]; offered: boolean };

/**
 * The file of a stack and the container that delivered it, the anchor for
 * everything after — and the containers before it that had no file (#185).
 */
export type ComposeLookup = { file: ComposeFile; anchorId: string; skipped: string[] };

/**
 * Asks the candidates one after the other until one delivers the file.
 *
 * ⚠️ ONE AFTER THE OTHER AND NOT ALL AT ONCE. Every request writes an audit
 * entry on the arm; a `Promise.all` over all containers of a stack would write
 * one per container in the normal case, where the first one delivers.
 *
 * ⚠️ IT GOES ON ONLY OVER A MISSING FILE (#183), since #185 by the hub's code
 * `compose-file-missing`, which also carries the three anchor reasons. Measured on 2026-09-29
 * at the arm `unraid`: the first container of the stack `minecraft_arc_2026`
 * carried labels naming more than one file and the arm answered `compose-datei-
 * fehlt` for it, while the other two containers of the same stack delivered.
 * Every other failure (allowlist, arm unreachable, read-only) holds for the
 * stack and not for one container, and a second try would bring the same answer
 * and one more audit entry.
 */
export async function fetchFirstCompose(hostId: string, candidates: string[]): Promise<ComposeLookup> {
  const walk: ComposeWalk = { searched: [], skipped: [], offered: false };
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return { file: await fetchCompose(hostId, candidate), anchorId: candidate, skipped: walk.skipped };
    } catch (error) {
      if (!isComposeFileMissing(error)) throw new ComposeLookupError(error, walk);
      const dir = searchedDir(error);
      if (dir !== null && !walk.searched.includes(dir)) walk.searched.push(dir);
      walk.skipped.push(candidate);
      walk.offered = selectionOffered(error);
      lastError = error;
    }
  }
  throw new ComposeLookupError(lastError, walk);
}

/**
 * The compose file of a stack, through the containers of the stack.
 *
 * ⚠️ THE CONTAINER IDS ARE PART OF THE KEY. They come from the overview, and
 * after an apply `compose up` replaces the containers: the key of the new
 * overview is a new question, and the old answer is no answer to it.
 *
 * ⚠️ NO RETRY. A walk through the candidates that failed has written its audit
 * entries already; the default policy of the app would run it a second time on
 * a network error, and the wrapped error would not even be recognised as an
 * answer of the hub.
 *
 * `enabled` is false while the tab waits for the overview after an apply
 * (#233): asking with the ids of before ends in `404 container-unknown`.
 */
export function useComposeFile(hostId: string, containerIds: string[], enabled: boolean) {
  const candidates = containerIds.join(",");
  return useQuery({
    queryKey: queryKeys.compose.file(hostId, candidates),
    queryFn: () => fetchFirstCompose(hostId, candidates.split(",")),
    enabled: enabled && candidates !== "",
    retry: false,
    ...ONCE_PER_OPENING
  });
}

/**
 * The two ways to ask for the file again.
 *
 * - `reload` throws the answer away and asks again; the tab shows "loading" in
 *   between, as the button always meant "take the other side's state".
 * - `forget` drops the answer WITHOUT asking. After an apply the ids of the
 *   cached answer are gone, and the tab asks again only once the new overview
 *   is there (`enabled` of `useComposeFile`); a reset at that moment would ask
 *   at once, with the old ids.
 */
export function useComposeFileReload(hostId: string) {
  const client = useQueryClient();
  const reload = useCallback(() => {
    void client.resetQueries({ queryKey: queryKeys.compose.files(hostId) });
  }, [client, hostId]);
  const forget = useCallback(() => {
    client.removeQueries({ queryKey: queryKeys.compose.files(hostId) });
  }, [client, hostId]);
  return { reload, forget };
}

/**
 * `GET …/compose/candidates`: the files the arm offers for one container
 * (#185). Asked once per opening of the selection, like every read here; a
 * refused path asks again explicitly (`refetch`).
 */
export function useComposeCandidates(hostId: string, containerId: string) {
  return useQuery({
    queryKey: queryKeys.compose.candidates(hostId, containerId),
    queryFn: () => fetchComposeCandidates(hostId, containerId),
    retry: false,
    ...ONCE_PER_OPENING
  });
}

/**
 * `GET …/compose/env`, masked: keys and whether a value is set, no value.
 *
 * ⚠️ THE PLAINTEXT IS NOT PART OF THIS QUERY. It is a separate, explicit action
 * (`useRevealEnv`), so a value never ends up in a cache entry that outlives the
 * click.
 */
export function useProjectEnv(hostId: string, containerId: string) {
  return useQuery({
    queryKey: queryKeys.compose.env(hostId, containerId),
    queryFn: () => fetchProjectEnv(hostId, containerId),
    ...ONCE_PER_OPENING
  });
}

/**
 * `GET …/compose/env?plaintext=1` on a click.
 *
 * ⚠️ `gcTime: 0` ON A MUTATION TOO: the values it returns are secrets, and the
 * result lives in the mutation cache for five minutes by default, long after
 * the view that asked for them is gone. `reset()` is "hide".
 */
export function useRevealEnv(hostId: string, containerId: string) {
  return useMutation<ProjectEnv>({
    mutationFn: () => fetchProjectEnv(hostId, containerId, true),
    gcTime: 0
  });
}

/**
 * `POST …/compose/preview`: what a draft would do, without writing anything.
 *
 * ⚠️ THE DRAFT IS PART OF THE QUESTION. A new text is a new key and shows
 * "loading" until its answer is there; with the old answer on screen the
 * operator would confirm services that his current text no longer has.
 */
export function useComposePreview(hostId: string, containerId: string, draft: string) {
  return useQuery({
    queryKey: queryKeys.compose.preview(hostId, containerId, draft),
    queryFn: () => previewCompose(hostId, containerId, draft),
    ...ONCE_PER_OPENING
  });
}
