import { useTranslations, type Messages } from "use-intl";

import type { Role, SessionUser } from "../../platform/session/session-user";
import { knownKey } from "../../platform/i18n/wire-labels";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Card } from "../../platform/ui/shadcn/card";

// Die Tafel „Mein Profil" (Artboard hub-palette.html Z. 725–733).
//
// ⚠️ ZWEI DER VIER FELDER DES ARTBOARDS FEHLEN, und zwar nicht aus Versehen:
//
//   * „Passwort — zuletzt geändert vor 3 Monaten" (Z. 730). Es gibt kein
//     Datum der letzten Passwortänderung. Weder `SessionUser` noch
//     `GET /api/users` führen eines, und in `"account"` (002-auth.sql) steht
//     der Hash ohne eine solche Marke. Der Satz im Artboard ist eine
//     Beschriftung, keine Zahl.
//   * „Aktive Sitzungen — 2 Geräte · Firefox · Linux, Safari · iPhone"
//     (Z. 731). Eine GERÄTELISTE liefert der Server nicht. `GET /api/users`
//     gibt je Konto eine ZAHL (`sessionCount`) heraus, und die steht dort, wo
//     sie herkommt: in der Konten-Tabelle daneben. Wer keine Adminrolle
//     trägt, bekommt diese Route gar nicht — für ihn gäbe es die Zahl also
//     ohnehin nicht.
//
// Beide erscheinen deshalb NICHT als leeres oder ausgegrautes Feld: „leer ist
// erlaubt, ausgegraut nicht" (Regel des Betreibers aus D3). Ein Feld, das es
// nicht gibt, steht nicht da und wartet auch nicht.

// ⚠️ Dieselbe Zuordnung führt `web/src/app/shell/AppSidebar.tsx` für das
// Namensschild. Sie steht hier trotzdem noch einmal und wird NICHT von dort
// geholt: die Richtung ginge sonst vom Bildschirm zur Schale, und ein
// Bildschirm zöge den Rahmen mitsamt Navigation und ⌘K-Suche in seinen
// Modulbaum, nur um an zwei Schlüssel zu kommen. Wächst die Zuordnung über
// zwei Rollen hinaus, gehört sie in ein eigenes Modul neben `Role` — heute
// wäre das ein Modul für zwei Zeilen.
const ROLE_LABEL_KEYS: Record<Role, keyof Messages> = {
  admin: "roleAdmin",
  user: "roleUser"
};

export function ProfilePanel({ user }: { user: SessionUser }) {
  const t = useTranslations();
  // ⚠️ Nachgeschlagen und nicht indiziert (`i18n/wire-labels.ts`): die Rolle
  // kommt aus der Antwort des Servers, und `Record<Role, …>[rolle]` war am
  // 2026-09-07 die gemessene Ursache eines stillen `MISSING_MESSAGE` an
  // anderer Stelle. Eine dritte Rolle ließe hier nichts stehen.
  const roleKey = knownKey(ROLE_LABEL_KEYS, user.role);

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      {/* Kopf der Tafel wie an der Stack-Seite: Titel links, die Nebenangabe
          rechts. Im Artboard steht dort „Administrator seit 2026-06-14"; das
          DATUM gibt es nicht — `"user"."createdAt"` verlässt den Server nicht
          —, die ROLLE gibt es. Sie steht deshalb allein da, statt einen Satz
          zu vervollständigen, dessen zweite Hälfte erfunden wäre. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("accountProfileTitle")}</span>
        <Badge variant="secondary" className="ml-auto">
          {roleKey === null ? t("roleUnknown", { role: user.role }) : t(roleKey)}
        </Badge>
      </div>

      {/* `dl` und nicht eine Tabelle: es sind Paare aus Bezeichnung und Wert,
          keine Zeilen mit Spalten. Das Artboard schreibt dieselbe Form. */}
      <dl className="grid gap-x-6 gap-y-3 px-4 py-4 text-[13px] sm:grid-cols-[max-content_1fr]">
        <dt className="text-subtle-foreground">{t("accountNameLabel")}</dt>
        <dd className="min-w-0 truncate">{user.name}</dd>
        <dt className="text-subtle-foreground">{t("accountEmailLabel")}</dt>
        <dd className="min-w-0 truncate">{user.email}</dd>
      </dl>
    </Card>
  );
}
