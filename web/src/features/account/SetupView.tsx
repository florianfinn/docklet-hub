import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import { signUp } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { Label } from "../../platform/ui/shadcn/label";
import { AuthCard, authFieldLabelClassName } from "./AuthCard";

// Die Erstanmeldung. Sie erscheint genau einmal im Leben eines Hubs — solange
// kein Konto existiert (server/src/platform/auth/setup-gate.ts).
//
// Deshalb erklärt sie sich selbst: wer sie sieht, sieht sie zum ersten und
// letzten Mal und hat keine Gelegenheit, den Ablauf noch einmal nachzulesen.
//
// Die Landmarke `main` steht in `AuthCard` und nicht hier: dieser Bildschirm
// liegt darin, ein zweites `main` wären zwei Hauptlandmarken auf einem Weg.

type SetupViewProps = {
  onDone: () => void;
  // The ground behind the card, handed in by `App.tsx` (see `AuthCard`).
  background?: ReactNode;
};

export function SetupView({ onDone, background }: SetupViewProps) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setError(null);
    void signUp({ name, email, password })
      .then(onDone)
      .catch(() => setError(t("setupFailed")))
      .finally(() => setBusy(false));
  };

  return (
    <AuthCard title={t("setupTitle")} lead={t("setupLead")} error={error} onSubmit={submit} background={background}>
      {/* ⚠️ `htmlFor` und `id` an jedem Paar: `Label` aus D2 ist
          `LabelPrimitive.Root` und umschließt sein Feld nicht — ohne die
          Verbindung liest ein Screenreader ein Feld ohne Namen vor, und ein
          Klick auf die Beschriftung setzt den Fokus nicht. */}
      <div className="flex flex-col gap-[7px]">
        <Label className={authFieldLabelClassName} htmlFor="setup-name">
          {t("setupNameLabel")}
        </Label>
        <Input
          id="setup-name"
          className="h-[38px] bg-muted"
          value={name}
          autoComplete="name"
          onChange={(event) => setName(event.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-[7px]">
        <Label className={authFieldLabelClassName} htmlFor="setup-email">
          {t("setupEmailLabel")}
        </Label>
        <Input
          id="setup-email"
          className="h-[38px] bg-muted"
          type="email"
          value={email}
          autoComplete="username"
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </div>

      <div className="flex flex-col gap-[7px]">
        <Label className={authFieldLabelClassName} htmlFor="setup-password">
          {t("setupPasswordLabel")}
        </Label>
        {/* ⚠️ `minLength` steht am Feld und der Hinweis daneben. Beides gehört
            zusammen: die Schranke allein wiese beim Absenden ab, ohne je gesagt
            zu haben, was verlangt ist. */}
        <Input
          id="setup-password"
          className="h-[38px] bg-muted"
          type="password"
          value={password}
          autoComplete="new-password"
          minLength={12}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        <span className="text-[12px] text-subtle-foreground">{t("setupPasswordHint")}</span>
      </div>

      <Button className="mt-1 h-[38px] w-full" type="submit" disabled={busy}>
        {busy ? t("loading") : t("setupSubmit")}
      </Button>
    </AuthCard>
  );
}
