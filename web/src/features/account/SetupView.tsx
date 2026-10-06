import { useState, type ReactNode } from "react";
import { useTranslations } from "use-intl";

import { signUp } from "./api";
import { Button } from "../../platform/ui/shadcn/button";
import { Input } from "../../platform/ui/shadcn/input";
import { Switch } from "../../platform/ui/shadcn/switch";
import { Label } from "../../platform/ui/shadcn/label";
import { AuthCard, authFieldLabelClassName } from "./AuthCard";

type SetupViewProps = {
  onDone: () => void;
  // The ground behind the card, handed in by `App.tsx` (see `AuthCard`).
  background?: ReactNode;
};

export function SetupView({ onDone, background }: SetupViewProps) {
  const t = useTranslations();
  const [applyComposeDefinition, setApplyComposeDefinition] = useState(true);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = () => {
    setBusy(true);
    setError(null);
    void signUp({ name, email, password, applyComposeDefinition })
      .then(onDone)
      .catch(() => setError(t("setupFailed")))
      .finally(() => setBusy(false));
  };

  return (
    <AuthCard title={t("setupTitle")} lead={t("setupLead")} error={error} onSubmit={submit} background={background}>
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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="setup-compose-definition">{t("setupComposeDefinitionLabel")}</Label>
          <Switch id="setup-compose-definition" checked={applyComposeDefinition} disabled={busy}
            onCheckedChange={setApplyComposeDefinition} aria-describedby="setup-compose-definition-hint" />
        </div>
        <p id="setup-compose-definition-hint" className="text-xs text-subtle-foreground">{t("setupComposeDefinitionHint")}</p>
      </div>

      <Button className="mt-1 h-[38px] w-full" type="submit" disabled={busy}>
        {busy ? t("loading") : t("setupSubmit")}
      </Button>
    </AuthCard>
  );
}
