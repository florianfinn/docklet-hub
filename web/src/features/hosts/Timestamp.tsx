import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "use-intl";

import { formatAgo, formatDateTime } from "../../platform/i18n/time-format";

// Ein Zeitpunkt samt Alter: „29.09.26, 22:15 (vor 3 Minuten)“ (#205).
//
// ⚠️ DAS ALTER LÄUFT MIT. Die Hosts-Seite bleibt oft lange offen, und ein
// „vor 1 Minute“, das nach einer Stunde noch dasteht, ist genau die alte
// Wahrheit, gegen die diese Angabe gebaut ist. Der Takt ist eine halbe Minute:
// feiner zeigt die Angabe ohnehin nicht an, sobald sie über eine Minute ist.
const TICK_MS = 30_000;

export function Timestamp({ at }: { at: string }) {
  const t = useTranslations();
  const language = useLocale();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return <>{at}</>;
  return (
    <time dateTime={at}>
      {t("timeAtAgo", { at: formatDateTime(language, date), ago: formatAgo(language, date, now) })}
    </time>
  );
}
