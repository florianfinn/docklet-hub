import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import { signIn } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { AuthCard, authFieldLabelClassName } from "./AuthCard";

// Die Anmeldung.
//
// ⚠️ Die Fehlermeldung unterscheidet NICHT zwischen „Konto gibt es nicht" und
// „Passwort stimmt nicht". Der Unterschied hilft dem Angemeldeten nicht und
// sagt jedem anderen, welche Adressen hier ein Konto haben.
//
// Die Landmarke `main` steht in `AuthCard` und nicht hier: dieser Bildschirm
// liegt darin, ein zweites `main` wären zwei Hauptlandmarken auf einem Weg.
//
// ⚠️ `expired` IST DIE SICHTBARE HÄLFTE VON #127. Ein 401 mitten in der Arbeit
// führt über `web/src/platform/http/session-expiry.ts` und `web/src/App.tsx` hierher.
// Ohne den Satz stünde am Ende einer Handlung, die der Mensch gerade
// ausgelöst hat, unerklärt das Anmeldeformular — und die naheliegende Deutung
// wäre, der Hub habe ihn hinausgeworfen oder sei abgestürzt.
//
// ⚠️ `expired` IST PFLICHT UND HAT KEINEN VORGABEWERT. Ein `expired?: boolean`
// ließe die Eigenschaft an der Aufrufstelle weg — und der Bildschirm wäre
// wieder der von vorher, ohne dass etwas rot wird. Es gibt genau eine
// Aufrufstelle (`web/src/App.tsx`), und die kennt die Antwort.
//
// ⚠️ ALS `lead` UND NICHT ALS `error`. Der rote Kasten in `AuthCard` gehört
// dem, was der Mensch gerade falsch gemacht hat (`signInFailed` nach einem
// falschen Passwort); ein abgelaufener Sitzungsschlüssel ist keine
// Fehleingabe. Der Satz steht deshalb dort, wo `SetupView` seine Erklärung
// hat — und wird vom roten Kasten überschrieben, sobald es zusätzlich etwas
// zu bemängeln gibt.

type SignInViewProps = {
  onDone: () => void;
  expired: boolean;
  // The ground behind the card, handed in by `App.tsx` (see `AuthCard`).
  background?: ReactNode;
};

export function SignInView({ onDone, expired, background }: SignInViewProps) {
  const t = useTranslations();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setError(null);
    void signIn({ email, password })
      .then(onDone)
      .catch(() => setError(t("signInFailed")))
      .finally(() => setBusy(false));
  };

  return (
    <AuthCard
      title={t("signInTitle")}
      lead={expired ? t("signInExpired") : undefined}
      background={background}
      error={error}
      onSubmit={submit}
    >
      {/* ⚠️ `htmlFor` und `id` an jedem Paar: `Label` aus D2 ist
          `LabelPrimitive.Root` und umschließt sein Feld nicht — ohne die
          Verbindung liest ein Screenreader ein Feld ohne Namen vor, und ein
          Klick auf die Beschriftung setzt den Fokus nicht. */}
      <div className="flex flex-col gap-[7px]">
        <Label className={authFieldLabelClassName} htmlFor="sign-in-email">
          {t("signInEmailLabel")}
        </Label>
        <Input
          id="sign-in-email"
          className="h-[38px] bg-muted"
          type="email"
          value={email}
          autoComplete="username"
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-[7px]">
        <Label className={authFieldLabelClassName} htmlFor="sign-in-password">
          {t("signInPasswordLabel")}
        </Label>
        <Input
          id="sign-in-password"
          className="h-[38px] bg-muted"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      <Button className="mt-1 h-[38px] w-full" type="submit" disabled={busy}>
        {busy ? t("loading") : t("signInSubmit")}
      </Button>
    </AuthCard>
  );
}
