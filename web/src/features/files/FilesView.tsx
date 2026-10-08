import { FileSourceContext } from "./source-context";
import { SourceChooser } from "./SourceChooser";
import { useCallback } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { useTranslations } from "use-intl";

import { Button } from "../../platform/ui/shadcn/button";
import { FileEditor } from "./FileEditor";
import { FileList } from "./FileList";
import { ShareChooser } from "./ShareChooser";
import type { ShareCandidate } from "./api";
import { fileErrorKey, isShareUnset } from "./file-errors";
import { FILES_EDIT_PARAM, FILES_PATH_PARAM } from "./file-paths";
import {
  useFileSources,
  useContainerShare,
  useFileListing,
  useListingRefresh,
  useShareCandidates,
  useShareChoice
} from "./file-queries";

// The file surface of a container (web FTP), package B5 (#5); since #263 in
// `features/files/` and loaded through queries (`file-queries.ts`).
//
// ⚠️ TWO STATES, AND THE FIRST IS THE MORE IMPORTANT ONE. Without a chosen
// share there is no file access; the agent answers everything with `409`.
// That is the normal state of every container nobody has chosen for yet, not
// a fault.
//
// ⚠️ THE FIRST QUESTION IS "WHICH SHARE IS CHOSEN?", NOT "WHAT IS IN THIS
// DIRECTORY?" (stage E5b). The same status `409` carries three meanings on
// this surface (`share-unset`, `share-unknown`, `agent-conflict`); reading the
// start state out of a failing listing depended on picking the right one.
// `GET …/share` answers the question directly.
//
// ⚠️ THE WAY THROUGH `share-unset` STAYS AS A FALLBACK, AND IT IS NO
// DUPLICATE. Time passes between the two requests: the share can be released
// in a second tab (`DELETE …/share`), and a registry sync can drop it. Two
// requests are not one point in time. Whoever "tidies up" this branch builds a
// window in which the surface shows an error where a choice belongs.
//
// ⚠️ THE PRICE, measured and not estimated: one request MORE on the first
// open when a share is set (share + listing instead of the listing only). A
// change of directory stays at one — the share does not hang on the path.
//
// ⚠️ THIS COMPONENT LOADS ONLY WHEN IT IS MOUNTED, and `ContainerScreen`
// mounts only the CURRENT tab. The promise "the closed tab opens no stream"
// (`web/tests/container-screen.test.tsx`) holds here as well: a tab nobody sees
// calls no route. That is why the branch stands in `ContainerScreen` and there
// is no `hidden` on this surface.
//
// ⚠️ AFTER AN UPLOAD, A NEW FOLDER, A RENAME OR A DELETE THE LIST IS LOADED
// AGAIN, through `useListingRefresh`: the parts beside this file load nothing
// themselves. A surface that reports success and leaves the old list standing
// shows a file that no longer exists, and the next click on it ends in a
// `404` that looks like a fault.

export function FilesView({ hostId, containerId }: { hostId: string; containerId: string }) {
  const t = useTranslations();
  const { pathname } = useLocation();
  // ⚠️ DER PFAD IN DER FREIGABE KOMMT AUS DER ADRESSE UND NICHT AUS EINEM
  // `useState` — dieselbe Begründung wie beim Reiter, ausführlich in
  // `file-paths.ts`. Und er kommt DEKODIERT herein: `useSearchParams` nimmt
  // das ab, ein zweites `decodeURIComponent` machte aus einem Namen still einen
  // anderen.
  const [params] = useSearchParams();
  const sourceId = params.get("sourceId") ?? undefined;
  const sources = useFileSources(hostId, containerId);
  const path = params.get(FILES_PATH_PARAM) ?? "";
  // ⚠️ `null` HEISST „KEIN EDITOR OFFEN" und ist nicht dasselbe wie der leere
  // Text: ein `?edit=` ohne Wert wäre die Bitte, ein VERZEICHNIS als Text zu
  // öffnen, und der Server antwortete darauf `400`.
  const editing = params.get(FILES_EDIT_PARAM);
  const navigate = useNavigate();

  const share = useContainerShare(hostId, containerId);
  const shareSet = !!sourceId || (share.isSuccess && share.data !== null);
  const listing = useFileListing(hostId, containerId, path, shareSet, sourceId);
  // ⚠️ ONLY `share-unset` LEADS INTO THE CHOICE. A `409 share-unknown` comes
  // from `PUT …/share` and means the opposite — a path the candidate list does
  // not hold. Treating both alike sent the operator back into the choice they
  // have just made.
  const listingLostShare = shareSet && listing.isError && isShareUnset(listing.error);
  const candidates = useShareCandidates(
    hostId,
    containerId,
    (share.isSuccess && share.data === null) || listingLostShare
  );
  // ⚠️ ONE ERROR AT A TIME. A choice and a release each keep their own error;
  // starting one clears the other's, so a failed release from before a new
  // choice does not stand above the list that choice brought.
  const { choose, release } = useShareChoice(hostId, containerId);
  const refreshListing = useListingRefresh(hostId, containerId);

  // ⚠️ DIE ADRESSE WIRD GEBAUT UND NICHT ZUSAMMENGESETZT: `encodeURIComponent`
  // beim BAUEN, kein `decodeURIComponent` beim Lesen. Ein Verzeichnisname darf
  // alles enthalten, was ein Dateisystem erlaubt — ein „&" darin begänne ohne
  // Kodierung einen zweiten Abfrageparameter, ein „#" schnitte den Rest der
  // Adresse ab.
  const hrefFor = useCallback(
    (next: string): string =>
      `${pathname}?${sourceId ? `sourceId=${encodeURIComponent(sourceId)}&` : ""}${FILES_PATH_PARAM}=${encodeURIComponent(next)}`,
    [pathname, sourceId]
  );

  /**
   * Die Adresse DIESES Verzeichnisses mit geöffnetem Editor für eine Datei.
   *
   * ⚠️ SIE TRÄGT BEIDE PARAMETER. Nur `edit` zu setzen verlöre das
   * Verzeichnis: ein Neuladen zeigte dann den Editor über der Wurzel der
   * Freigabe, und der Weg zurück führte irgendwohin.
   */
  const editHrefFor = useCallback(
    (file: string): string => {
      const here = path === "" ? "" : `${FILES_PATH_PARAM}=${encodeURIComponent(path)}&`;
      return `${pathname}?${sourceId ? `sourceId=${encodeURIComponent(sourceId)}&` : ""}${here}${FILES_EDIT_PARAM}=${encodeURIComponent(file)}`;
    },
    [pathname, path, sourceId]
  );

  /**
   * Der Editor zu — zurück auf die Adresse ohne `edit`.
   *
   * `replace` und kein neuer Eintrag: das Schließen ist die Rücknahme des
   * Öffnens, und zweimal „zurück" für einen Blick in eine Datei wäre eine
   * Falle in der Verlaufsleiste.
   */
  const closeEditor = useCallback(() => {
    void navigate(hrefFor(path), { replace: true });
  }, [navigate, hrefFor, path]);

  const loading = <p className="text-muted-foreground">{t("loading")}</p>;
  const failed = (error: unknown) => (
    <p className="text-sm text-destructive" data-testid="files-error">
      {t(fileErrorKey(error))}
    </p>
  );

  // The choice is drawn as a box of its own, reached from the share query and
  // from the fallback of the listing. One call, two ways to it.
  const chooser = (list: ShareCandidate[]) => (
    <div data-testid="files-view" data-phase="choosing">
      <ShareChooser
        candidates={list}
        onChoose={(relative) => {
          release.reset();
          choose.mutate(relative);
        }}
        pending={choose.isPending ? (choose.variables ?? null) : null}
        error={choose.isError ? t(fileErrorKey(choose.error)) : null}
      />
    </div>
  );
  const candidateChoice = () => {
    if (candidates.isError) return failed(candidates.error);
    if (candidates.data === undefined) return loading;
    return chooser(candidates.data);
  };

  // ⚠️ THE FIRST QUESTION FIRST. While its answer is out, everything else is
  // unknown; and if it says "none chosen", there is nothing to list. Both are
  // decided HERE and not inferred from a failing listing.
  if (sources.isError) return failed(sources.error);
  if (share.isError && !sourceId) return failed(share.error);
  if (!share.isSuccess && !sourceId) return loading;
  if (share.data === null && !sourceId) return <><SourceChooser sources={sources.data?.sources ?? []} pathname={pathname} />{candidateChoice()}</>;

  const selectedSource = sources.data?.sources.find((source) => source.sourceId === sourceId);
  const activeSource = selectedSource ?? sources.data?.sources.find((source) => source.kind === "project" && source.source === share.data?.path);
  if (selectedSource?.estimatedBytes !== null && selectedSource?.estimatedBytes !== undefined) {
    return <FileSourceContext value={sourceId}>
      <SourceChooser sources={sources.data?.sources ?? []} pathname={pathname} selected={sourceId} />
      {editing !== null ? <FileEditor hostId={hostId} containerId={containerId} path="" syntaxPath={selectedSource.target} writable={selectedSource.writable} replacementWarning={false}
        onClose={closeEditor} onSaved={() => { void sources.refetch(); }} />
        : <Button onClick={() => { void navigate(editHrefFor("")); }}>{t("filesEditorLabel")}</Button>}
    </FileSourceContext>;
  }

  // ⚠️ AN ERROR BEFORE THE DATA. A failed reload keeps the old list in the
  // cache; showing it would present a directory as current that could not be
  // read just now.
  if (listing.isError) return listingLostShare ? candidateChoice() : failed(listing.error);

  // ⚠️ NO DATA FOR THIS PATH IS "LOADING", AND IT IS WHAT KEEPS DIRECTORIES
  // APART. The key carries the path: on a change of directory the list of the
  // previous one is not shown as if it were the new one's. A reload after an
  // upload keeps the key, so the list stays while it runs, and with it the
  // receipt of the upload (#136).
  const shown = listing.data;
  if (shown === undefined) return loading;

  return (
    <FileSourceContext value={sourceId}>
    <div
      className="flex flex-col gap-3"
      data-testid="files-view"
      data-phase="listing"
      // ⚠️ EINE ANGABE UND KEIN BILD: die Liste steht sichtbar da wie vorher,
      // aber ein laufendes Neuholen ist damit prüfbar. Ohne sie ließe sich
      // „die Fläche bleibt stehen" nicht von „es wird gar nicht mehr geholt"
      // unterscheiden — zwei Fassungen, die auf dem Bild gleich aussehen.
      data-refreshing={listing.isFetching ? "true" : undefined}
    >
      <SourceChooser sources={sources.data?.sources ?? []} pathname={pathname} selected={sourceId} />
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
        <p className="text-[13px] text-subtle-foreground">
          {t("filesCurrentShare", { share: shown.listing.share })}
        </p>
        {/* ⚠️ DER WEG ZURÜCK AUS DER WAHL steht hier und nicht in einem Menü:
            was hier verschwindet, verschwindet beim nächsten Registry-Abgleich
            auch aus der Allowlist des Arms — das ist die Handlung, mit der ein
            Betreiber den Zugriff wieder zumacht, und sie darf nicht versteckt
            sein. */}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="files-share-release"
          onClick={() => {
            choose.reset();
            release.mutate();
          }}
        >
          {t("filesShareRelease")}
        </Button>
      </div>

      {release.isError ? (
        <p className="text-[13px] text-destructive" data-testid="files-share-error">
          {t(fileErrorKey(release.error))}
        </p>
      ) : null}

      {/* ⚠️ DER EDITOR STEHT ÜBER DER LISTE UND NICHT AN IHRER STELLE. Wer eine
          Konfigurationsdatei bearbeitet, schaut dabei auf die Nachbardateien —
          und der Weg zurück in die Liste ist dann kein Klick, sondern nur der
          Blick nach unten. */}
      {editing === null || editing === "" ? null : (
        <FileEditor
          sourceIdentity={sourceId ?? share.data?.path ?? "unknown"}
          writable={activeSource ? activeSource.writable : shown.listing.diagnostics?.uploadable !== false}
          replacementWarning={shown.listing.diagnostics?.deletable !== true}
          hostId={hostId}
          containerId={containerId}
          path={editing}
          onClose={closeEditor}
          onSaved={refreshListing}
        />
      )}

      <FileList
        listing={shown.listing}
        maxUploadBytes={shown.maxUploadBytes}
        hostId={hostId}
        containerId={containerId}
        hrefFor={hrefFor}
        editHrefFor={editHrefFor}
        onChanged={refreshListing}
      />
    </div>
    </FileSourceContext>
  );
}
