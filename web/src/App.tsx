import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslations } from "use-intl";

import { ApiError } from "./platform/http/transport";
import { fetchSession, fetchSetupState } from "./platform/session/api";
import type { SessionUser } from "./platform/session/session-user";
import { onUnauthorized } from "./platform/http/session-expiry";
import { useGlobalTheme } from "./features/appearance";
import { useLanguage } from "./platform/i18n";
import { DotWave } from "./platform/ui/dot-wave";
import { AppRoutes } from "./app/routes/AppRoutes";
import { SetupView, SignInView } from "./features/account";
import { AppShell, PlainShell } from "./app/shell/AppShell";

// Welcher der drei Bildschirme gilt.
//
// Die Reihenfolge ist der Inhalt dieser Datei, und sie ist nicht beliebig:
// zuerst die Frage, ob es überhaupt ein Konto gibt, dann die nach der
// Sitzung. Andersherum sähe ein frischer Betrieb den Anmeldebildschirm für
// ein Konto, das es nicht gibt — und der Betreiber suchte nach Zugangsdaten,
// die niemand je vergeben hat.

// ⚠️ `expired` AM ZUSTAND UND NICHT ALS ZWEITER ZUSTAND. „Anmeldung" und
// „Anmeldung nach Ablauf" sind derselbe Bildschirm mit demselben Formular;
// ein eigenes `kind` daneben zwänge jeden `switch` und jeden Effekt in dieser
// Datei, beide aufzuzählen — und der nächste, der einen vergisst, bekommt
// nach einem Ablauf eine Seite ohne Aussehen oder ohne Sprache. Was sich
// unterscheidet, ist ein Satz über dem Formular, und genau das trägt das Feld.
type State =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "signIn"; expired: boolean }
  | { kind: "signedIn"; user: SessionUser }
  | { kind: "failed" };

// Das Laden liegt außerhalb der Komponente und liefert den nächsten Zustand,
// statt ihn zu setzen.
//
// ⚠️ Das ist keine Stilfrage: eine Funktion, die im Effekt selbst `setState`
// ruft, erzeugt eine zweite Renderrunde und wird von der Hook-Regel
// zurückgewiesen. Hier setzt der Effekt den Zustand in einem Rückruf — und
// bekommt nebenbei die Abbruchmarke, ohne die eine Antwort auf eine bereits
// verlassene Ansicht schriebe.
async function loadState(): Promise<State> {
  try {
    const setup = await fetchSetupState();
    if (setup.open) return { kind: "setup" };
    const session = await fetchSession();
    return { kind: "signedIn", user: session.user };
  } catch (error) {
    // 401 ist hier kein Fehler, sondern die Antwort: niemand angemeldet.
    return error instanceof ApiError && error.status === 401
      ? { kind: "signIn", expired: false }
      : { kind: "failed" };
  }
}

// ⚠️ Die Zuordnung von Eintrag auf Fläche stand bis D6b HIER, als
// `screenFor(itemId, user)` neben einem `useState` mit dem aktiven Eintrag.
// Seit D6b steht sie in `web/src/app/routes/AppRoutes.tsx` und heißt Route: die
// Adresse trägt den Zustand, nicht diese Datei. Was geblieben ist, ist die
// Frage, die diese Datei beantwortet — WER zusieht, nicht WAS er sieht.

export function App() {
  const t = useTranslations();
  const { adopt } = useLanguage();
  const { load: loadTheme, reset: resetTheme } = useGlobalTheme();
  const queryClient = useQueryClient();
  const [state, setState] = useState<State>({ kind: "loading" });
  // Jeder Zähler-Schritt ist ein neuer Ladevorgang. Ein Auslöser, der nichts
  // bedeutet außer „noch einmal" — daran hängt der Effekt, statt an einer
  // Funktion, die dabei neu entstünde.
  const [reloadCount, setReloadCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadState().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadCount]);

  // Der 401 MITTEN IN DER ARBEIT (#127).
  //
  // Der Transport meldet jeden 401 hierher (`web/src/platform/http/session-expiry.ts`);
  // diese Datei entscheidet, ob einer eine abgelaufene Sitzung ist. Das ist
  // genau dann der Fall, wenn gerade jemand angemeldet WAR — jeder andere 401
  // gehört zum normalen Betrieb und darf nichts umschalten: der beim Start ist
  // die Antwort „niemand angemeldet" und wird oben in `loadState` gelesen, der
  // aus einer fehlgeschlagenen Anmeldung ist ein falsches Passwort, und der
  // nach dem Abmelden trifft den Zustand `loading`, den `reload` gerade
  // gesetzt hat.
  //
  // ⚠️ Die Prüfung steht IM Aktualisierer und nicht davor. `state` aus dem
  // Abschluss wäre der Stand beim Anmelden des Zuhörers — also für immer
  // `loading`, denn der Effekt hängt an keiner Abhängigkeit und läuft genau
  // einmal. React reicht dem Aktualisierer den aktuellen Stand.
  useEffect(
    () =>
      onUnauthorized(() => {
        setState((current) => (current.kind === "signedIn" ? { kind: "signIn", expired: true } : current));
      }),
    []
  );

  // The query cache belongs to a session (#256).
  //
  // ⚠️ IT IS EMPTIED WHENEVER NOBODY IS SIGNED IN, not only on an expiry. What
  // the last account loaded — its arms, their containers — would otherwise be
  // on the screen of the next one to sign in in this tab, before the first
  // request of the new session has answered, and it is not theirs to see. The
  // expiry itself needs nothing here: a 401 from a query is an `ApiError`, and
  // its constructor reports it to the listener above, as for every other
  // request (`platform/http/session-expiry.ts`).
  useEffect(() => {
    if (state.kind !== "signedIn") queryClient.clear();
  }, [state.kind, queryClient]);

  // Sobald die Sitzung steht, gilt die Sprache des Kontos — aber nur lesend:
  // `adopt` schreibt bewusst nicht zurück, sonst schriebe jede Anmeldung die
  // Einstellung fest, die sie gerade erst gelesen hat. Der Umschalter, der
  // schreibt, sitzt anderswo. Das Übernehmen steht in einem eigenen Effekt,
  // nicht im Rendern selbst — sonst liefe es bei jedem Durchlauf erneut.
  useEffect(() => {
    if (state.kind === "signedIn") adopt(state.user.language);
  }, [state, adopt]);

  // Die globalen Stellschrauben stehen hinter `withSession`. Der Abruf hängt
  // deshalb an DIESER Frage — „wer sieht zu" — und nicht am Einhängen der
  // Schicht: `GET /api/settings` vor der Anmeldung endet in einer 401, und
  // dieselbe Falle steht in `web/tests/auth-screens.test.mjs` für den
  // Sprachanbieter schon unter einer Maschine.
  //
  // Der zweite Zweig ist kein Beiwerk: nach dem Abmelden trägt die Seite sonst
  // weiter das Aussehen, das der Hub gespeichert hat — auf einem Bildschirm,
  // vor dem niemand mehr angemeldet ist. Vor der Anmeldung gilt die Vorgabe.
  useEffect(() => {
    if (state.kind === "signedIn") loadTheme();
    if (state.kind === "signIn" || state.kind === "setup") resetTheme();
  }, [state.kind, loadTheme, resetTheme]);

  const reload = () => {
    setState({ kind: "loading" });
    setReloadCount((count) => count + 1);
  };

  // Vier der fünf Zustände liegen im schlanken Rahmen, einer in der Schale.
  //
  // ⚠️ Das Abmelden ist aus dem Bildschirm in die Schale gewandert: das
  // Namensschild unten links steht in jeder angemeldeten Ansicht, der
  // Bildschirm darunter wechselt. `OverviewScreen` bekommt deshalb weder Name
  // noch Rückruf. Die Rolle bekommt er über `AppRoutes` — seit D5 nicht mehr
  // für die Host-Aktionen (die stehen im `HostsScreen`), seit dem Ausblenden
  // von Stacks für das Kontextmenü an der Stack-Zeile.
  //
  // ⚠️ Die Hauptlandmarke `main`: `PlainShell` setzt bewusst keine — wer darin
  // steht, bringt seine Landmarke selbst mit. `SetupView` und `SignInView`
  // bekommen sie über `AuthCard` (`web/src/features/account/AuthCard.tsx`, seit D4 an
  // der Stelle des gelöschten `FormShell`), die angemeldete Ansicht über
  // `SidebarInset`. Die beiden zustandslosen Meldungen unten haben keinen
  // Bildschirm, nur einen Absatz — ihre Landmarke steht deshalb HIER. Ohne sie
  // hätte das Dokument in diesen zwei Zuständen gar keine, und ein
  // Screenreader fände keinen Einstieg in den Inhalt. Sie in `PlainShell` zu
  // setzen wäre der falsche Ort: bei Einrichtung und Anmeldung entstünde
  // wieder die Verschachtelung, die in diesem Paket schon behoben wurde.
  switch (state.kind) {
    case "loading":
      return (
        <PlainShell>
          <main className="p-8 text-muted-foreground">{t("loading")}</main>
        </PlainShell>
      );
    case "setup":
      return (
        <PlainShell>
          <SetupView onDone={reload} background={<DotWave />} />
        </PlainShell>
      );
    case "signIn":
      return (
        <PlainShell>
          <SignInView onDone={reload} expired={state.expired} background={<DotWave />} />
        </PlainShell>
      );
    case "signedIn":
      return (
        <AppShell userName={state.user.name} role={state.user.role} onSignedOut={reload}>
          <AppRoutes user={state.user} />
        </AppShell>
      );
    case "failed":
      return (
        <PlainShell>
          <main className="p-8">
            <p className="text-destructive">{t("containersFailed")}</p>
            <button className="mt-3 underline" type="button" onClick={reload}>
              {t("retry")}
            </button>
          </main>
        </PlainShell>
      );
  }
}
