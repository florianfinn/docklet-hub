// Eigene Datei, kein Herkunftskopf — nicht übernommen. Die shadcn-Registry
// liefert unter dem Baustein `utils` nur den Platzhalter
// `export { cn } from "cn"`, den sonst das eigene Kommandozeilenwerkzeug von
// shadcn ersetzt. Ohne dieses Werkzeug ist die übliche Fassung von Hand
// geschrieben.
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
