// Die Argumente des Break-Glass — ohne Datenbank und ohne Seiteneffekt.
//
// Getrennt vom Werkzeug selbst, damit die Auswertung prüfbar ist, ohne dass
// ein Postgres läuft (AGENTS.md, Tests). Was hier schiefgeht, geht in einem
// Moment schief, in dem der Betreiber ohnehin schon ausgesperrt ist — eine
// Meldung, die den Tippfehler benennt, ist dort mehr wert als anderswo.

export const COMMANDS = ["list", "create-admin", "promote", "reset-password"] as const;

export type Command = (typeof COMMANDS)[number];

export type ParsedArguments =
  | { kind: "help" }
  | { kind: "command"; command: "list" }
  | { kind: "command"; command: "create-admin"; email: string; name: string }
  | { kind: "command"; command: "promote" | "reset-password"; email: string }
  | { kind: "error"; message: string };

export const HELP = `Break-Glass — der Weg zurück in einen ausgesperrten Hub.

Er läuft ohne Weboberfläche, weil das System, über das man sich sonst wieder
hereinließe, genau dieses ist. Ein Zugang zum Container und zur Datenbank
genügt:

  docker compose exec hub node server/dist/platform/auth/break-glass.js <befehl>

Befehle:
  list                     Alle Konten mit ihrer Rolle
  create-admin <e-mail>    Neues Admin-Konto, Passwort wird erzeugt und
                           einmalig ausgegeben
                           [--name "Vorname Nachname"]
  promote <e-mail>         Bestehendes Konto zum Admin machen
  reset-password <e-mail>  Neues Passwort erzeugen und alle Sitzungen dieses
                           Kontos beenden

Das erzeugte Passwort steht genau einmal auf dem Bildschirm. Es wird nicht
protokolliert und lässt sich nicht erneut anzeigen — nur neu erzeugen.`;

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

function readOption(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

// Nicht die vollständige Grammatik aus RFC 5322 — die will hier niemand. Es
// geht um den Tippfehler, der sonst als Konto in der Tabelle landet, das sich
// nie anmelden kann.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional = argv.filter((value) => !value.startsWith("--"));
  const [first, ...rest] = positional;

  if (!first || argv.includes("--help") || argv.includes("-h") || first === "help") {
    return { kind: "help" };
  }
  if (!isCommand(first)) {
    return { kind: "error", message: `Unbekannter Befehl „${first}". Bekannt sind: ${COMMANDS.join(", ")}.` };
  }
  const command = first;
  if (command === "list") return { kind: "command", command: "list" };

  const email = rest[0];
  if (!email) {
    return { kind: "error", message: `„${command}" braucht eine E-Mail-Adresse.` };
  }
  if (!EMAIL_PATTERN.test(email)) {
    return { kind: "error", message: `„${email}" sieht nicht wie eine E-Mail-Adresse aus.` };
  }

  if (command === "create-admin") {
    // Ohne Namen bleibt die Oberfläche nicht leer, sondern zeigt den Teil vor
    // dem @. Ein Pflichtfeld wäre hier eine Frage an jemanden, der gerade
    // ausgesperrt ist.
    const name = readOption(argv, "name")?.trim() || email.split("@")[0];
    return { kind: "command", command, email, name };
  }
  return { kind: "command", command, email };
}
