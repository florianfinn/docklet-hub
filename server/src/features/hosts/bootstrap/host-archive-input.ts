// Die Eingabe des Archiv-Erzeugers, wie sie der Entwurf festlegt
// (docs/design/phase-4-bootstrap-and-registration.md §5).
//
// Eine eigene Datei, damit die Vorlagen sie lesen können, ohne dass
// `host-archive.ts` sie wieder einlesen muss. Der Vertrag nach außen bleibt
// der Re-Export aus `host-archive.ts`.
export type HostArchiveInput = {
  host: {
    id: string;
    name: string;
    kind: "internal" | "external";
    tunnelAddress: string;
    // Die zwei Werte, die dem ZIELHOST gehören (008-host-setup.sql).
    //
    // ⚠️ `null` heißt „der Hub weiß es nicht" und nicht „nimm die Vorgabe":
    // ein Arm aus der Zeit vor 008 hat sie nicht. Die Vorlagen unterscheiden
    // beide Fälle sichtbar — die `.env` lässt die Zeile dann leer, und die
    // README verlangt den Handgriff, den sie sonst nur noch nachprüft.
    dockerGid: number | null;
    bindBasePath: string | null;
  };
  hub: { endpoint: string; publicKey: string; tunnelCidr: string; hubAddress: string };
  agent: { image: string; port: number; secret: string; privateKey: string };
  registration: { url: string; token: string };
};

/**
 * Der Basispfad, unter dem der Agent Bind-Mounts von Compose-Projekten
 * zulässt. Die Vorgabe stammt aus dashboard-docker-agent@v0.18.1
 * (`src/config.ts`); sie steht ausgeschrieben in der `.env`, weil sie auf dem
 * Zielhost je nach Ablage geändert werden muss und ein stiller Vorgabewert
 * dort nicht auffällt.
 */
export const DEFAULT_BIND_BASE_PATH = "/home/docker";
