import { Boxes, LayoutGrid, Server, type LucideIcon } from "lucide-react";
import type { useTranslations } from "use-intl";

// Der Schlüsseltyp kommt aus dem Rückgabetyp des Hooks selbst und nicht aus
// `keyof Messages`: `useTranslations()` nimmt seine Schlüssel über einen
// eigenen Hilfstyp der Bibliothek entgegen (eine Vereinfachung von Pfaden mit
// Punkt-Notation), und dieser Weg bleibt richtig, auch wenn sich die Form der
// Übersetzungsdatei ändert.
//
// ⚠️ Hier stand, ein `keyof Messages` werde von `t(...)` NICHT angenommen. Das
// war falsch, und zwar schon, als es hingeschrieben wurde: gemessen am
// 2026-09-05 kompiliert `export type TranslationKey = keyof Messages;` an
// dieser Stelle fehlerfrei, und drei Dateien desselben Baums tun genau das
// bereits — `app/screens/OverviewScreen.tsx`, `screens/hosts/HostRow.tsx` und
// `domain/hosts/host-status.tsx` führen ihre Zuordnungen als
// `Record<…, keyof Messages>` und reichen deren Werte an `t(…)` weiter. Beide
// Wege gehen; dieser ist der schmalere, weil er nicht an der Form von
// `Messages` hängt. Ein Grund, der nicht stimmt, ist kein Grund.
export type TranslationKey = Parameters<ReturnType<typeof useTranslations>>[0];

// Die Navigationsdaten der Schale — eine Liste, kein JSX.
//
// Warum Daten und nicht Markup: die Seitenleiste zeichnet diese Liste, und die
// ⌘K-Suche durchsucht dieselbe. Zwei Stellen, eine Quelle. Wächst die Liste,
// wächst beides mit, ohne dass jemand die Suche anfasst.
//
// ⚠️ Heute stehen hier GENAU DREI Einträge, und das ist kein Rückstand,
// sondern der Bestand: „Container" ist mit D6b dazugekommen, weil es die
// Fläche seit D6b GIBT (`web/src/app/screens/ContainersScreen.tsx`). Überwachung,
// Freischaltung und Verlauf aus dem Artboard existieren nicht. Die Seite eines
// Stacks existiert, gehört aber nicht hierher: sie wird ERREICHT und nicht
// angesteuert und trägt ihren Pfad in `standaloneRoutes`. Die Regel des
// Projekts lautet: Einträge, die es noch nicht gibt, erscheinen nicht — kein
// Ausgrauen. Ein ausgegrauter Eintrag wäre eine Lüge über den Bestand, und ein
// Eintrag wartet nicht auf seinen Bildschirm, er entsteht mit ihm.
//
// Der zweite Eintrag kam mit D5 (#62) dazu — als EINE Zeile in
// `navigationItems`, wie hier angekündigt. Dazu kam allerdings noch etwas, das
// bei einem einzigen Eintrag niemandem auffiel: bis dahin RENDERTE die
// Anwendung immer denselben Bildschirm, ganz gleich, welcher Eintrag aktiv
// war. Die Zuordnung von Eintrag auf Fläche steht seit D6b in der
// Routentabelle (`web/src/app/routes/AppRoutes.tsx`), und ein Wächter
// (`web/tests/screen-switching.test.mjs`) hält sie gegen diese Liste.

// Die Überschriften der Gruppen, als Zuordnung und ausdrücklich NICHT als
// Liste von Objekten.
//
// ⚠️ Der Grund ist der Wächter `web/tests/shell-navigation.test.mjs`: er liest
// jedes Objekt der obersten Ebene eines Array-Literals in dieser Datei als
// Navigationseintrag und verlangt für jedes eine vorhandene Fläche unter
// `web/src/app/screens/`. Eine Gruppe hat keine Fläche. Stünde sie als Objekt in
// einer Liste, meldete der Wächter sie zu Recht als Eintrag ohne Bildschirm.
// Als Zuordnung steht sie außerhalb jeder eckigen Klammer und bleibt, was sie
// ist: eine Überschrift.
export const navigationGroupLabelKeys = {
  operations: "navGroupOperations" satisfies TranslationKey
} as const;

export type NavigationGroupId = keyof typeof navigationGroupLabelKeys;

// Die Reihenfolge der Gruppen in der Seitenleiste ist die Reihenfolge ihrer
// Schlüssel oben.
export const navigationGroupIds = Object.keys(navigationGroupLabelKeys) as NavigationGroupId[];

// Der Bereich, der die Schale färbt (D6b, #62;
// docs/design/hub-color-and-structure.md §1 und §2, „Bereich": Sättigung
// `--c × 0.32`, gedämpft). Genau zwei Töne sind ihm fest reserviert — 225
// Betrieb, 325 Verwaltung, `web/src/platform/theme/palette.css` Z. 131 f. — und
// „es gibt genau diese zwei Bereiche" (§1): ein dritter Wert ist kein
// Tippfehler, den es zu beheben gäbe, sondern eine Änderung an diesem
// Vertrag.
export type AreaId = "operations" | "management";

export type NavigationItem = {
  // Die Kennung des Eintrags. Sie verbindet den Eintrag mit der Fläche, die er
  // rendert (die Routentabelle in `web/src/app/routes/AppRoutes.tsx` ist nach ihr
  // geschlüsselt). Den AKTIVEN Zustand trägt sie seit D6b nicht mehr: der
  // kommt aus der Adresse, nicht aus einem `useState`.
  id: string;
  group: NavigationGroupId;
  // Der Bereich dieses Eintrags. Heute bei allen drei Einträgen „operations",
  // weil die Navigation ausschließlich Betriebsflächen führt — Profil und
  // Einstellungen hängen am Namensschild und haben keinen Eintrag hier (siehe
  // `managementPaths` weiter unten). `areaForPath` liest DIESES Feld für jede
  // Adresse, die einen Eintrag hat, und geht für den Rest zu `managementPaths`
  // weiter.
  area: AreaId;
  // Der Pfad, unter dem die Fläche dieses Eintrags steht — mit führendem „/".
  //
  // ⚠️ HIER steht der Pfad und NUR hier. Die Seitenleiste zeichnet ihn als Ziel
  // eines Verweises, die ⌘K-Suche springt darauf, und die Routentabelle liest
  // ihn beim Aufspannen der Routen. Stünde er zusätzlich dort, gäbe es zwei
  // Stellen, an denen „/hosts" geschrieben wird — und die erste Umbenennung
  // ließe eine davon stehen. Ein Wächter
  // (`web/tests/shell-navigation.test.mjs`, Zusicherung 1) macht jeden Eintrag
  // rot, dem der Pfad fehlt; ein zweiter
  // (`web/tests/screen-switching.test.mjs`) macht jeden Pfad rot, der zweimal
  // vorkommt.
  //
  // Ein Pfad mit Parameter (`/stack/:hostId/:project`) ist hier möglich, steht
  // aber an einem Navigationseintrag nie: ein Menüpunkt kennt seine Kennungen
  // nicht. Solche Pfade tragen die Routen OHNE Eintrag in der Routentabelle.
  path: string;
  // Der Dateiname des Bildschirms OHNE Endung unter `web/src/app/screens/`.
  //
  // ⚠️ Dieses Feld wird heute von keinem Bauteil gelesen, und das ist Absicht:
  // es ist die maschinell prüfbare Verbindung zwischen Eintrag und Fläche. Der
  // Wächter löst den Wert dorthin auf und macht jeden Eintrag rot, dessen
  // Fläche es nicht gibt. Wer hier einen Namen einträgt, den es nicht gibt,
  // erfährt es beim nächsten `pnpm run test` und nicht erst im Betrieb.
  screen: string;
  labelKey: TranslationKey;
  icon: LucideIcon;
};

export const navigationItems: NavigationItem[] = [
  { id: "overview", group: "operations", area: "operations", path: "/", screen: "OverviewScreen", labelKey: "navOverview", icon: LayoutGrid },
  { id: "containers", group: "operations", area: "operations", path: "/containers", screen: "ContainersScreen", labelKey: "navContainers", icon: Boxes },
  { id: "hosts", group: "operations", area: "operations", path: "/hosts", screen: "HostsScreen", labelKey: "navHosts", icon: Server }
];

// Der Pfad, auf dem die Anwendung beim Start steht — der erste Eintrag.
//
// ⚠️ Er heißt seit D6b `defaultNavigationPath` und nicht mehr
// `defaultNavigationItemId`: gebraucht wird er dort, wo eine unbekannte Adresse
// auf etwas Bekanntes zurückfällt, und das ist ein Pfad und keine Kennung.
export const defaultNavigationPath = navigationItems[0].path;

// Der Eintrag zu einer Adresse, oder `undefined`.
//
// ⚠️ Verglichen wird der GANZE Pfad und nicht nur sein Anfang: „/hosts" und ein
// späteres „/hosts/detail" wären sonst derselbe Eintrag, und die Brotkrume
// zeigte auf der Detailfläche die Überschrift der Liste. Wer eine Fläche ohne
// Eintrag öffnet (die Stack-Seite, „Mein Konto"), bekommt hier `undefined` —
// das ist kein Fehler, sondern die Antwort.
export function navigationItemForPath(pathname: string): NavigationItem | undefined {
  return navigationItems.find((item) => item.path === pathname);
}

// Die Adressen ohne Navigationseintrag, die trotzdem zur Verwaltung gehören —
// „Mein Konto" und „Einstellungen" (docs/design/hub-color-and-structure.md
// §5, „Verwaltung hängt am Profil"). Ihr Pfad steht KANONISCH in
// `standaloneRoutes` (`web/src/app/routes/AppRoutes.tsx`, dort mit Bildschirm und
// Element) — diese Zuordnung ist bewusst schlank und trägt keinen Bildschirm,
// weil `AppShell.tsx` die Bildschirme nicht kennen darf (Begründung dort,
// oben an `standaloneRoutesFor`). Die zwei Pfade stehen deshalb ein zweites
// Mal hier, statt aus jener Datei importiert zu werden — der Wächter dort
// (`web/tests/screen-switching.test.mjs`) verlangt ein Zeichenketten-LITERAL
// je Route und ließe eine Referenz nicht als Pfad durchgehen.
//
// ⚠️ EIN OBJEKT UND KEIN ARRAY — aus demselben Grund wie
// `navigationGroupLabelKeys` oben: der Wächter
// (`web/tests/shell-navigation.test.mjs`, Zusicherung 1) liest JEDES Objekt
// der obersten Ebene JEDES Array-Literals dieser Datei als Navigationseintrag
// und verlangt ein Pflichtfeld „screen". Eine Liste `{ path, area }[]` würde
// er zu Recht als zwei Einträge ohne Fläche meldern. Als Zuordnung fällt sie
// nicht in kein Array und bleibt außerhalb seiner Suche.
//
// ⚠️ Die Stack-Seite steht NICHT hier: sie ist Betrieb (der Fallback unten),
// nicht Verwaltung — sie wird von der Übersicht und dem Deepdive aus
// erreicht, beide Betriebsflächen.
//
// ⚠️ Diese Zuordnung ist die WIRKSAME — `areaForPath` liest sie. Die Angabe
// `area` an derselben Route in `standaloneRoutes` liest niemand; damit sie
// nicht lautlos etwas anderes behauptet, hält
// `web/tests/screen-switching.test.mjs` („der Bereich einer Route ohne
// Eintrag steht an beiden Stellen gleich") beide gegeneinander. Ein Pfad hier,
// unter dem keine Route liegt, ist dort ebenfalls rot — er färbte nie etwas
// und fiele sonst niemandem auf.
const managementPaths: Record<string, AreaId> = {
  "/account": "management",
  "/settings": "management"
};

// Der Bereich zu einer Adresse — für die Schale, die ihn NICHT mehr fest
// trägt, sondern an `useLocation()` hängt (D6b, #62). Trägt eine Adresse
// einen Navigationseintrag, gilt dessen Feld `area`; sonst entscheidet
// `managementPaths`; alles andere ist „operations" — der Regelfall, unter dem
// auch die Stack-Seite steht.
export function areaForPath(pathname: string): AreaId {
  const item = navigationItemForPath(pathname);
  if (item !== undefined) return item.area;
  return managementPaths[pathname] ?? "operations";
}
