import { useTranslations, type Messages } from "use-intl";

import type { Role } from "../../platform/session/session-user";
import type { UserAccount } from "./api";
import { formatSignInTime } from "../../platform/i18n/last-sign-in";
import { knownKey } from "../../platform/i18n/wire-labels";
import { useLanguage } from "../../platform/i18n";
import { Badge } from "../../platform/ui/shadcn/badge";
import { Card } from "../../platform/ui/shadcn/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from "../../platform/ui/shadcn/table";


// Die Tafel „Konten" (Artboard hub-palette.html Z. 735–757): Name, Rolle,
// letzte Anmeldung, Sitzungen.
//
// ⚠️ SIE ERSCHEINT NUR FÜR EINE ADMINROLLE. Die Entscheidung darüber fällt
// eine Ebene höher (`AccountView`), und zwar VOR dem Laden: `GET /api/users`
// steht hinter `requireAdmin` und antwortete jedem anderen mit 403. Diese
// Tafel bekommt deshalb nie einen Fehler zu sehen, den die Rolle erklärt —
// nur einen, der wirklich einer ist.
//
// ⚠️ OHNE ROLLENWECHSEL. Das Artboard schreibt in den Kopf „Rollen ändert nur
// ein Administrator" (Z. 736), und das klingt nach einem Wähler in der Zeile.
// Es gibt keine Route, die eine Rolle ändert (D6b ist lesend), und ein Wähler
// ohne Wirkung ist dieselbe Lüge wie ein ausgegrauter Knopf. Die Zeile zeigt
// die Rolle als Marke und nicht als Bedienelement.

const ROLE_LABEL_KEYS: Record<Role, keyof Messages> = {
  admin: "roleAdmin",
  user: "roleUser"
};

/**
 * Die Rolle als Text — nachgeschlagen und nicht indiziert.
 *
 * ⚠️ Der Grund steht in `i18n/wire-labels.ts`: `role` kommt aus der Antwort
 * des Servers, und `Record<Role, …>[role]` ergibt bei einer dritten Rolle zur
 * Laufzeit `undefined`. `use-intl` wirft darauf, fängt es selbst wieder ab und
 * zeichnet nichts — die Spalte bliebe LEER, und leer sieht nach „keine Rolle"
 * aus und nicht nach einem Fehler.
 *
 * ⚠️ Als Funktion und nicht als Konstante in der Komponente: die Zelle steht
 * in einer Schleife über die Konten, und die Rolle ist je Zeile eine andere.
 */
function roleLabel(t: ReturnType<typeof useTranslations>, role: string): string {
  const key = knownKey(ROLE_LABEL_KEYS, role);
  return key === null ? t("roleUnknown", { role }) : t(key);
}

type AccountsPanelProps = {
  // `null`, solange die Antwort aussteht — dieselbe Unterscheidung wie an den
  // Betriebsflächen: „wird geholt" ist nicht „ist leer".
  accounts: UserAccount[] | null;
  failed: boolean;
  // Die Kennung des eigenen Kontos. Sie kommt aus der Sitzung und nicht aus
  // einem Vergleich der Namen: zwei Konten dürfen denselben Namen tragen
  // (server/src/users/users.ts), nur nicht dieselbe Kennung.
  selfId: string;
};

export function AccountsPanel({ accounts, failed, selfId }: AccountsPanelProps) {
  const t = useTranslations();
  const { language } = useLanguage();

  return (
    <Card className="gap-0 overflow-hidden border-accent-line bg-body-face py-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-head-face px-4 py-2.5">
        <span className="text-sm font-medium">{t("accountsTitle")}</span>
      </div>

      <div className="px-4 py-3">
        {failed ? <p className="text-sm text-destructive">{t("accountsFailed")}</p> : null}
        {!failed && accounts === null ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : null}

        {accounts !== null ? (
          // Die Tabelle bringt ihren eigenen waagerechten Rollbereich mit
          // (`overflow-x-auto` im übernommenen Baustein) — deshalb steht hier
          // keine zweite Hülle dafür.
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("accountsColumnName")}</TableHead>
                <TableHead>{t("accountsColumnRole")}</TableHead>
                <TableHead>{t("accountsColumnLastSignIn")}</TableHead>
                {/* Eine Zahl steht rechtsbündig: so lassen sich zwei
                    untereinander vergleichen, ohne sie zu lesen. */}
                <TableHead className="text-right">{t("accountsColumnSessions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.map((account) => {
                const self = account.id === selfId;
                return (
                  // ⚠️ `data-self` wie im Artboard (Z. 747), und die Fläche
                  // dazu ist `--accent` — genau das, was dessen Regel
                  // `tr[data-self="true"] td { background: var(--accent) }`
                  // (Z. 333) sagt. Die Marke daneben ist kein Zierrat: eine
                  // Auszeichnung, die NUR aus einer Hintergrundfarbe besteht,
                  // erreicht niemanden, der die Zeile vorgelesen bekommt.
                  // ⚠️ `undefined` statt `false` für die fremden Zeilen: ein
                  // `data-self="false"` stünde sonst an jeder Zeile im Baum
                  // und wäre eine Angabe, die nichts aussagt. Das Artboard
                  // zeichnet nur die eine Zeile aus.
                  <TableRow
                    key={account.id}
                    data-self={self ? "true" : undefined}
                    className="data-[self=true]:bg-accent"
                  >
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="truncate">{account.name}</span>
                        {self ? (
                          <Badge variant="outline" className="text-subtle-foreground">
                            {t("accountsSelf")}
                          </Badge>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>{roleLabel(t, account.role)}</TableCell>
                    <TableCell className="text-subtle-foreground">
                      {account.lastSignInAt === null
                        ? t("accountsNeverSignedIn")
                        : formatSignInTime(account.lastSignInAt, language)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{account.sessionCount}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
      </div>
    </Card>
  );
}
