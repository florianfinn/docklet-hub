import { Eye, EyeOff } from "lucide-react";
import { useTranslations } from "use-intl";

import { errorCode } from "../../platform/http/transport";
import { Button } from "../../platform/ui/shadcn/button";
import { composeErrorKey } from "./compose-errors";
import { useProjectEnv, useRevealEnv } from "./compose-queries";

// The `.env` of the project next to the compose file (#265: loaded through
// `compose-queries.ts`). The masked list is a query; the plaintext is a click
// and lives only as long as this view shows it (`useRevealEnv`).

function envErrorKey(error: unknown): ReturnType<typeof composeErrorKey> | "composeEnvOwnStack" {
  return errorCode(error) === "hub-own-stack" ? "composeEnvOwnStack" : composeErrorKey(error);
}

export function EnvView({ hostId, containerId }: { hostId: string; containerId: string }) {
  const t = useTranslations();
  const masked = useProjectEnv(hostId, containerId);
  const reveal = useRevealEnv(hostId, containerId);

  // The plaintext, once asked for, replaces the masked list until "hide".
  const env = reveal.data ?? masked.data;
  const failure = reveal.error ?? masked.error;

  if (failure !== null) return <p className="p-4 text-sm text-destructive">{t(envErrorKey(failure))}</p>;
  if (env === undefined) return <p className="p-4 text-sm text-muted-foreground">{t("loading")}</p>;

  return (
    <div className="flex min-h-[40vh] flex-col">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-accent-line bg-accent px-3 py-1.5">
        <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground" title={env.projectDir}>
          {env.projectDir}
        </span>
        {env.filePresent && env.entries.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={reveal.isPending}
            onClick={() => { if (env.plaintext) reveal.reset(); else reveal.mutate(); }}
          >
            {env.plaintext ? <EyeOff data-icon="inline-start" aria-hidden="true" /> : <Eye data-icon="inline-start" aria-hidden="true" />}
            {t(env.plaintext ? "composeEnvHide" : "composeEnvReveal")}
          </Button>
        ) : null}
      </div>
      {!env.filePresent ? (
        <p className="p-4 text-sm text-muted-foreground">{t("composeEnvMissing")}</p>
      ) : env.entries.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">{t("composeEnvEmpty")}</p>
      ) : (
        <div className="max-h-[70vh] overflow-auto py-3 font-mono text-[12.5px] leading-[1.55]" data-testid="compose-env-content">
          <div className="min-w-fit">
            {env.entries.map((entry, index) => (
              <div key={entry.key} className="flex whitespace-pre">
                <span aria-hidden="true" className="sticky left-0 min-w-10 select-none border-r border-border bg-card pr-2 pl-3 text-right text-subtle-foreground">{index + 1}</span>
                <span className="px-3">
                  <span className="compose-syntax-key">{entry.key}</span>
                  <span>=</span>
                  <span className="compose-syntax-string">{env.plaintext && entry.value !== undefined ? entry.value.replace(/\r/g, "\\r").replace(/\n/g, "\\n") : entry.empty ? "" : "••••••••"}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {env.filePresent && env.entries.length > 0 ? (
        <p className="border-t border-border px-3 py-2 text-[12px] text-muted-foreground">{t("composeEnvParsedNote")}</p>
      ) : null}
    </div>
  );
}
