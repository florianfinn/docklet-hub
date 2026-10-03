import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useTranslations } from "use-intl";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "../../platform/ui/shadcn/command";
import { navigationGroupIds, navigationGroupLabelKeys, navigationItems } from "./navigation";

// Die Suche per ⌘K, gebaut aus dem übernommenen Baustein `command` (er bringt
// den `CommandDialog` mit — ein eigener Dialog wäre eine zweite Auslegung
// desselben Bauteils).
//
// ⚠️ Durchsucht werden die Einträge aus `navigation.ts` — heute genau einer.
// Das ist wenig, aber es ist ECHT: eine Suche, die eine erfundene
// Ergebnisliste zeigt, wäre eine Attrappe, und Attrappen bleiben stehen.
// Wächst die Liste, wächst die Suche mit, ohne dass jemand sie anfasst.

// ⚠️ Die Taste ist gegen die Seitenleiste geprüft, nicht geraten:
// `web/src/platform/ui/shadcn/sidebar.tsx` belegt `SIDEBAR_KEYBOARD_SHORTCUT = "b"` für
// das Auf- und Zuklappen (gemessen mit
// `grep -n 'SIDEBAR_KEYBOARD_SHORTCUT' web/src/platform/ui/shadcn/sidebar.tsx`, Zeile 63
// und 130). „k" kollidiert damit nicht.
//
// Verglichen wird kleingeschrieben: mit gedrückter Umschalttaste liefert der
// Browser „K", und die Kombination soll trotzdem greifen.
const SEARCH_KEY = "k";

// ⚠️ Kein `onSelect` mehr. Bis D6b meldete die Suche die gewählte Kennung nach
// oben, und `web/src/App.tsx` setzte daraus seinen Zustand. Seit D6b springt
// sie selbst auf den PFAD des Eintrags — dieselbe Adresse, die auch der
// Verweis in der Seitenleiste trägt. Ein Rückruf durch zwei Schichten, nur um
// am Ende dasselbe zu tun, ist eine Schicht, die auseinanderlaufen kann.
type CommandPaletteProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const t = useTranslations();
  const navigate = useNavigate();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== SEARCH_KEY) return;
      // Beide Modifikatoren, weil beide Systeme gemeint sind: die Anzeige in
      // der Seitenleiste nennt das Befehlszeichen, Strg tut hier dasselbe.
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      onOpenChange(!open);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t("shellSearchPlaceholder")} />
      <CommandList>
        <CommandEmpty>{t("shellSearchEmpty")}</CommandEmpty>
        {navigationGroupIds.map((groupId) => (
          <CommandGroup key={groupId} heading={t(navigationGroupLabelKeys[groupId])}>
            {navigationItems
              .filter((item) => item.group === groupId)
              .map((item) => (
                <CommandItem
                  key={item.id}
                  value={t(item.labelKey)}
                  onSelect={() => {
                    // ⚠️ Ein `CommandItem` ist kein Verweis und kann keiner
                    // sein: `cmdk` wählt einen Eintrag auch mit der
                    // Eingabetaste aus, ohne dass jemand klickt. Der Sprung
                    // gehört deshalb hierher — und er geht auf DENSELBEN Pfad,
                    // den die Seitenleiste als Ziel trägt.
                    void navigate(item.path);
                    onOpenChange(false);
                  }}
                >
                  <item.icon aria-hidden="true" strokeWidth={1.8} />
                  <span>{t(item.labelKey)}</span>
                </CommandItem>
              ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
