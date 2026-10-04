// Welche Container zum Leitstand SELBST gehören — der Hub mit seinem Postgres
// und Sidecar, und auf jedem Arm Agent, WireGuard und Watcher.
//
// ⚠️ DIE REGEL STEHT HIER UND NICHT IM BROWSER, aus demselben Grund wie die
// Zusammenfassung eines Stacks (docs/design/hub-color-and-structure.md §5):
// sie ist Logik und keine Gestaltung. Übersicht, Deepdive und der Reiter
// „Hub & Agenten" der Einstellungen lesen dasselbe Feld `system`; eine zweite
// Fassung in JavaScript wäre die, die beim nächsten Image-Namen abweicht.
//
// ⚠️ ZWEI MERKMALE, und eines genügt:
//
//   1. Das IMAGE. Hub und Agent tragen feste Repository-Namen
//      (`docklet-hub`, `dashboard-docker-agent` — `docker-compose.yml`
//      und `server/src/features/hosts/bootstrap/host-archive-compose.ts`). Registry, Tag und
//      Digest davor und dahinter sind frei: die Images sind über
//      Umgebungsvariablen übersteuerbar (AGENTS.md, „Abhängigkeiten und
//      Images"), der Name des Repositorys bleibt dabei stehen.
//   2. Das COMPOSE-PROJEKT. Es fängt die Mitglieder ohne eigenes Image des
//      Leitstands — den Postgres des Hubs etwa. Sein Image heißt `postgres`,
//      sein Projekt `docklet-hub`.
//
// Ein Stack gilt als Leitstand, sobald EIN Mitglied es ist: ein Postgres
// neben dem Hub gehört zum Hub, auch wenn der Projektname übersteuert wurde
// (`COMPOSE_PROJECT_NAME`) und nur das Image des Hubs ihn verrät.

// `dashboard-docker-agent` is the image name up to v0.31.0 and stays here for
// arms that still run it; since #279 the agent image is `docklet-hub-agent`.
const SYSTEM_IMAGE_REPOSITORIES = new Set(["docklet-hub", "docklet-hub-agent", "dashboard-docker-agent"]);

// Projects of the generated arm archive (`host-archive-compose.ts`) and the
// templates in agent/deploy/; the `dashboard-docker-agent*` names stay for arms
// installed before the rename.
const SYSTEM_PROJECTS = new Set([
  "docklet-hub",
  "docklet-hub-agent-remote",
  "docklet-hub-agent-unraid",
  "dashboard-docker-agent",
  "dashboard-docker-agent-remote"
]);

/**
 * Der Name des Repositorys aus einer Image-Referenz, ohne Registry, Tag und
 * Digest (`ghcr.io/owner/dashboard-docker-agent:v0.30.0@sha256:…` →
 * `dashboard-docker-agent`).
 */
export function imageRepository(image: string): string {
  const withoutDigest = image.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const name = withoutDigest.slice(lastSlash + 1);
  const colon = name.indexOf(":");
  return (colon < 0 ? name : name.slice(0, colon)).toLowerCase();
}

export function isSystemImage(image: string): boolean {
  return SYSTEM_IMAGE_REPOSITORIES.has(imageRepository(image));
}

export function isSystemProject(project: string): boolean {
  return SYSTEM_PROJECTS.has(project.toLowerCase());
}
