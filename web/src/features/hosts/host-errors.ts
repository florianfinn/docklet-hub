import type { useTranslations } from "use-intl";

import { ApiError } from "../../platform/http/transport";

// Diese Datei ist keine Komponente und darf den Hook der Bibliothek deshalb
// nicht selbst rufen — `t` kommt als erstes Argument von den Aufrufern
// herein, die selbst in einer Komponente stehen.
type Translate = ReturnType<typeof useTranslations>;

// Die Codes aus §4 des Vertrags, an der Stelle in Text übersetzt, an der sie
// entstehen — keine `alert()`, keine Weiterleitung an eine allgemeine
// Fehlerseite.
//
// ⚠️ `400` trägt zwei verschiedene Ursachen (unbrauchbare Eingabe ODER
// fehlender `HUB_WIREGUARD_ENDPOINT`), und nur die zweite hat laut Vertrag
// „den Text der Meldung" im Rumpf. Der Rumpf wird deshalb zuerst versucht;
// erst wenn daraus keine lesbare Meldung zu holen ist, fällt der Text auf den
// allgemeinen Text für unbrauchbare Eingabe zurück.
//
// ⚠️ Die Meldung aus dem Rumpf ist eine deutsche Zeichenkette vom Server
// (aus `HUB_WIREGUARD_ENDPOINT` bzw. dessen Fehlen) und wird bewusst NICHT
// übersetzt: sie richtet sich an den Betreiber über seine eigene `.env`, nicht
// an die Person vor dem Bildschirm — eine Übersetzungsschicht hätte hier
// nichts zu übersetzen, weil der Text nie aus den Sprachdateien kam.
function readMessage(error: ApiError): string | null {
  try {
    const parsed = JSON.parse(error.message) as { message?: unknown; error?: unknown };
    const value = parsed.message ?? parsed.error;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function describeCreateHostError(t: Translate, error: unknown): string {
  if (!(error instanceof ApiError)) return t("hostCreateFailed");
  switch (error.status) {
    case 409:
      return t("hostErrorNameTaken");
    case 507:
      return t("hostErrorPoolExhausted");
    case 400:
      return readMessage(error) ?? t("hostErrorInvalidInput");
    default:
      return t("hostCreateFailed");
  }
}

export function describeRemoveHostError(t: Translate, error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return t("hostRemoveLocalError");
  return t("hostRemoveFailed");
}
