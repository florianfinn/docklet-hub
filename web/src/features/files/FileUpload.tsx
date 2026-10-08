import { useFileSource } from "./source-context";
import { Upload, X } from "lucide-react";
import type { Messages } from "use-intl";
import { useId, useRef, useState } from "react";
import { useTranslations } from "use-intl";

import {
  UploadAborted,
  uploadContainerFile,
  type FileListing,
  type UploadProgress
} from "./api";
import { byteSize, useLanguage } from "../../platform/i18n";
import { Button } from "../../platform/ui/shadcn/button";
import { fileErrorKey } from "./file-errors";

// Upload capability includes source policy and mount mode; the agent rechecks it.
// Unknown diagnostics defer to the agent.
//
// ⚠️ DIE GRÖSSE WIRD SEIT #136 VOR DEM SENDEN GEPRÜFT — mit der Zahl aus dem
// Umschlag von `GET …/files` und NICHT mit einer Konstante dieser Fläche.
// `MAX_UPLOAD_BYTES` ist ein Wert der Gegenseite und steht ausschließlich in
// `contract/src/agent/`; `web/tests/agent-protocol-values.test.mjs` macht eine
// zweite Deklaration rot — auch im Web. Der Server lehnt eine zu große Datei
// weiterhin mit `413 too-large` ab, und dieser Fehler wird weiterhin gezeigt:
// die Prüfung hier spart den Weg, sie ersetzt ihn nicht. Ohne sie lädt der
// Browser eine 500-MB-Datei vollständig hoch, bevor die `413` kommt.
//
// ⚠️ FORTSCHRITT UND ABBRUCH HÄNGEN AN `XMLHttpRequest` (`uploadContainerFile`
// in `web/src/features/files/api.ts`). `fetch` meldet den Fortschritt des SENDENS nicht;
// die Messung und die verworfene Alternative stehen dort.
//
// ⚠️ DER BALKEN IST VIER ZEILEN MARKUP UND KEIN BAUSTEIN. Schritt 1 aus
// AGENTS.md ist gegangen: `https://www.shadcnblocks.com/r/progress.json`
// antwortete am 2026-09-09 mit `404` („Block, component, example, or page not
// found"). Schritt 3 — die freie Registry — brächte `@radix-ui/react-progress`
// als neue Abhängigkeit für ein `div` mit einer Breite; „was in zwanzig Zeilen
// selbst geschrieben ist, wird selbst geschrieben" (AGENTS.md, Abhängigkeiten).
// Die Vorlesegeräte bekommen ihre Auskunft trotzdem: `role="progressbar"` mit
// `aria-valuenow`.
//
// ⚠️ KEIN `FormData` UND KEINE BASE64-UMKODIERUNG. Die Bytes gehen als roher
// Rumpf hinaus (`uploadContainerFile` in `web/src/features/files/api.ts`); der Grund und
// die Messung stehen im Kopf jener Datei.
//
// ⚠️ DAS DATEIFELD IST VERSTECKT UND WIRD ÜBER EIN `label` BEDIENT, und das ist
// eine GEMESSENE Entscheidung (Sichtprüfung am 2026-09-07, Chromium): ein
// sichtbares `<input type="file">` trägt die Beschriftung des BROWSERS, und die
// lautete in dieser deutschen Oberfläche „Choose File" und „No file chosen".
// Ihr Text lässt sich nicht setzen — `::file-selector-button` färbt den Knopf,
// beschriftet ihn aber nicht. Es ist derselbe Einwand, aus dem in D4 das
// `window.confirm` verschwunden ist: neben dem deutschen Satz standen zwei
// englische Schaltflächen des Systems.
//
// ⚠️ VERSTECKT HEISST `sr-only` UND NICHT `display: none`. Das Feld bleibt im
// Baum, bleibt mit der Tabulatortaste erreichbar und behält seine
// Beschriftung; ein `hidden` nähme es der Tastatur und den Vorlesegeräten weg.
// Der Fokusring wandert über `peer-focus-visible` auf das `label` — sonst
// stünde der Fokus auf einem Element, das niemand sieht.

/** Was die Diagnose über das Hochladen sagt — drei Fälle, nicht zwei. */
type Verdict = "allowed" | "blocked" | "unknown";

export function uploadVerdict(listing: FileListing): Verdict {
  if (listing.diagnostics === null) return "unknown";
  return listing.diagnostics.uploadable ? "allowed" : "blocked";
}

export function FileUpload({
  hostId,
  containerId,
  listing,
  maxUploadBytes,
  onUploaded
}: {
  hostId: string;
  containerId: string;
  listing: FileListing;
  /**
   * Wie viele Bytes der Arm in einem Zug annimmt — aus dem Umschlag von
   * `GET …/files`.
   *
   * ⚠️ SIE KOMMT HEREIN UND STEHT NICHT HIER. `MAX_UPLOAD_BYTES` ist ein
   * Vertragswert und wird genau einmal deklariert
   * (`web/tests/agent-protocol-values.test.mjs`); eine Zahl in dieser Datei wäre die zweite Wahrheit, die
   * still veraltet, sobald der Arm seine Grenze ändert.
   */
  maxUploadBytes: number;
  /** Nach einem geglückten Upload: die Liste noch einmal holen. */
  onUploaded: () => void;
}) {
  const t = useTranslations();
  const sourceId = useFileSource();
  const { language } = useLanguage();
  const verdict = uploadVerdict(listing);

  const input = useRef<HTMLInputElement | null>(null);
  // Die Kennung verbindet `label` und Feld. Sie kommt aus `useId` und nicht
  // aus einem festen Text: die Fläche steht je Verzeichnis einmal da, und zwei
  // gleiche Kennungen im Dokument machten aus zwei Feldern eines.
  const fieldId = useId();
  const [chosen, setChosen] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<keyof Messages | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [aborted, setAborted] = useState(false);
  // ⚠️ EIN `useRef` UND KEIN `useState`: der Abbruch wird beim Klick GELESEN
  // und nicht gezeichnet. Ein Zustand dafür löste je Upload ein zusätzliches
  // Rendern aus und wäre im Rückruf des Klicks obendrein der Stand des vorigen
  // Durchlaufs.
  const running = useRef<AbortController | null>(null);

  const blocked = verdict === "blocked";
  // Die Prüfung VOR dem Senden. Sie greift nur bei einer bekannten Grenze:
  // eine `0` hieße „der Server hat nichts gesagt", und daraus eine Sperre für
  // jede Datei zu machen wäre eine Behauptung über eine Prüfung, die nie
  // stattgefunden hat.
  const oversized = chosen !== null && maxUploadBytes > 0 && chosen.size > maxUploadBytes;

  /** Eine Bytezahl als Satz — dieselbe Rechnung wie in der Dateiliste. */
  const bytes = (value: number): string => {
    const size = byteSize(value, language);
    return t(size.key, { value: size.value });
  };

  const send = (): void => {
    if (chosen === null) return;
    // Der Riegel steht auch hier und nicht nur am Knopf: ein zweiter Aufrufer
    // dieser Funktion schickte die Datei sonst an der Prüfung vorbei.
    if (oversized) return;
    const controller = new AbortController();
    running.current = controller;
    setBusy(true);
    setDone(null);
    setErrorKey(null);
    setAborted(false);
    setProgress({ sent: 0, total: chosen.size });

    void uploadContainerFile(hostId, containerId, listing.path, chosen, {
      sourceId,
      signal: controller.signal,
      onProgress: setProgress
    })
      .then(({ uploaded }) => {
        setDone(uploaded.name);
        setChosen(null);
        // Das Feld selbst zurückstellen: ohne das stünde der Name der schon
        // hochgeladenen Datei weiter darin, und der nächste Klick schickte sie
        // ein zweites Mal.
        if (input.current !== null) input.current.value = "";
        onUploaded();
      })
      .catch((error: unknown) => {
        // ⚠️ DER ABBRUCH IST KEIN FEHLER, sondern die Entscheidung des
        // Betreibers. Als roter Satz gezeigt sähe die eigene Handlung wie eine
        // Störung aus — und die Datei bleibt gewählt, damit ein zweiter Versuch
        // ein Klick ist und keine zweite Wahl im Dateidialog.
        if (error instanceof UploadAborted) {
          setAborted(true);
          return;
        }
        setErrorKey(fileErrorKey(error));
      })
      .finally(() => {
        running.current = null;
        setBusy(false);
        setProgress(null);
      });
  };

  /**
   * Den laufenden Upload abbrechen.
   *
   * ⚠️ DIE VERBINDUNG WIRD WIRKLICH GESCHLOSSEN und nicht nur die Anzeige
   * zurückgestellt. Ein „Abbrechen", das die Bytes weiter hinausschickt, ist
   * eine Lüge über die Leitung — und der Upload landete trotzdem beim Arm.
   */
  const cancel = (): void => running.current?.abort();

  return (
    <div className="flex flex-col gap-1.5" data-testid="files-upload" data-verdict={verdict}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          id={fieldId}
          type="file"
          data-testid="files-upload-input"
          disabled={blocked || busy}
          className="peer sr-only"
          onChange={(event) => {
            setDone(null);
            setErrorKey(null);
            setAborted(false);
            setChosen(event.target.files?.[0] ?? null);
          }}
        />
        <label
          htmlFor={fieldId}
          data-testid="files-upload-choose"
          aria-disabled={blocked || busy}
          className="inline-flex h-8 cursor-pointer items-center rounded-md border border-input px-3 text-[13px] hover:bg-accent peer-focus-visible:border-ring peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/50 peer-disabled:pointer-events-none peer-disabled:opacity-50"
        >
          {t("filesUploadChoose")}
        </label>
        {/* Der gewählte Name in EIGENEM Text. Er stand vorher in der
            Beschriftung des Browsers und damit auf Englisch. */}
        <span className="min-w-0 truncate text-[13px] text-subtle-foreground" data-testid="files-upload-chosen">
          {chosen === null ? t("filesUploadNone") : chosen.name}
        </span>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={blocked || busy || oversized || chosen === null}
          data-testid="files-upload-submit"
          onClick={send}
        >
          <Upload aria-hidden="true" className="size-3.5" />
          {busy ? t("filesUploadPending") : t("filesUploadSubmit")}
        </Button>
        {/* Die Abbruchtaste steht nur da, solange es etwas abzubrechen gibt.
            Eine dauerhaft sichtbare, meist wirkungslose Taste wäre eine
            Behauptung über einen Zustand, der nicht gilt. */}
        {busy ? (
          <Button type="button" size="sm" variant="ghost" data-testid="files-upload-cancel" onClick={cancel}>
            <X aria-hidden="true" className="size-3.5" />
            {t("filesUploadCancel")}
          </Button>
        ) : null}
      </div>

      {/* ⚠️ DER BALKEN TRÄGT SEINE ZAHLEN AUCH ALS TEXT. Ein Betreiber, der
          über eine schmale Leitung lädt, will wissen, WIE VIEL von wie viel
          hinaus ist — „irgendwo in der Mitte" beantwortet die Frage nicht, ob
          das Warten noch lohnt. */}
      {progress === null ? null : (
        <div className="flex flex-col gap-1" data-testid="files-upload-progress">
          <div
            role="progressbar"
            aria-label={t("filesUploadPending")}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-valuenow={progress.sent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-card-line"
          >
            <div
              className="h-full bg-primary transition-[width] duration-150"
              style={{ width: `${progress.total === 0 ? 0 : Math.round((progress.sent / progress.total) * 100)}%` }}
            />
          </div>
          <p className="text-[12px] text-subtle-foreground">
            {t("filesUploadProgress", { sent: bytes(progress.sent), total: bytes(progress.total) })}
          </p>
        </div>
      )}

      {/* ⚠️ `role="alert"` und `text-state-warn` — wie `LogView.tsx` es tut.
          `text-warning-foreground` gibt es in diesem Theme nicht; ein Hinweis
          damit stünde in Fließtextfarbe da und fiele niemandem auf. */}
      {blocked ? (
        <p role="alert" className="text-[12px] text-state-warn" data-testid="files-upload-blocked">
          {t("filesUploadBlocked")}
        </p>
      ) : null}
      {verdict === "unknown" ? (
        <p role="alert" className="text-[12px] text-state-warn" data-testid="files-upload-unknown">
          {t("filesUploadUnknown")}
        </p>
      ) : null}

      {/* ⚠️ DER SATZ NENNT BEIDE ZAHLEN, und das ist kein Widerspruch zu
          `fileErrorTooLarge` daneben, wo die Zahl ausdrücklich fehlt. Dort
          stünde sie als LITERAL in der Sprachdatei und wäre eine zweite
          Wahrheit; hier reist sie zur Laufzeit aus der Vertragsdatei herein
          und ist dieselbe. */}
      {oversized ? (
        <p role="alert" className="text-[12px] text-destructive" data-testid="files-upload-too-large">
          {t("filesUploadTooLarge", {
            size: bytes(chosen.size),
            limit: bytes(maxUploadBytes)
          })}
        </p>
      ) : null}

      {errorKey === null ? null : (
        <p className="text-[12px] text-destructive" data-testid="files-upload-error">
          {t(errorKey)}
        </p>
      )}
      {aborted ? (
        <p className="text-[12px] text-subtle-foreground" data-testid="files-upload-aborted">
          {t("filesUploadAborted")}
        </p>
      ) : null}
      {done === null ? null : (
        <p className="text-[12px] text-subtle-foreground" data-testid="files-upload-done">
          {t("filesUploadDone", { name: done })}
        </p>
      )}
    </div>
  );
}
