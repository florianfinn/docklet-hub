import assert from "node:assert/strict";
import test from "node:test";

import type { ContainerOverviewEntry } from "../../domain/containers/index.js";
import { isHubOwnStack, ownShortId } from "./hub-own-stack.js";

// Der eigene Stack des Hubs (#183). Die Kennungen sind die, die am 2026-09-29
// auf dem Proxy gemessen wurden: `hostname` im Hub ergab `37bfb9511f3f`, und
// `docker compose ps -q` des Hub-Stacks führte genau diese Kennung.

function entry(id: string, project: string | null): ContainerOverviewEntry {
  return {
    id,
    name: id,
    image: "img:1",
    status: "running",
    running: true,
    startedAt: null,
    health: null,
    compose: project === null ? null : { project, service: id.slice(0, 4) },
    stats: null,
    externalManagement: null
  } as ContainerOverviewEntry;
}

const OWN = "37bfb9511f3f";
const HUB_WIREGUARD = entry(`${OWN}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, "docklet-hub");
const HUB_POSTGRES = entry("0a2f955d4583bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "docklet-hub");
const ADGUARD = entry("14b800ba578dcccccccccccccccccccccccccccccccccccccccccccccccccccc", "adguardhome");
const ALL = [HUB_WIREGUARD, HUB_POSTGRES, ADGUARD];

test("der Hostname zählt nur, wenn er wie eine Kurzkennung aussieht", () => {
  assert.equal(ownShortId(OWN), OWN);
  for (const name of ["dashboard-hub", "37BFB9511F3F", "37bfb9511f3", "37bfb9511f3f0", ""]) {
    assert.equal(ownShortId(name), null, `„${name}“ gilt als Kennung`);
  }
});

test("jeder Container des eigenen Projekts ist Anker des eigenen Stacks", () => {
  // ⚠️ Auch Postgres, dessen Kennung nicht der Hostname ist: der Anker des
  // Compose-Reiters ist irgendein Container des Stacks.
  assert.equal(isHubOwnStack(HUB_WIREGUARD, ALL, OWN), true);
  assert.equal(isHubOwnStack(HUB_POSTGRES, ALL, OWN), true);
});

test("ein fremder Stack ist es nicht", () => {
  assert.equal(isHubOwnStack(ADGUARD, ALL, OWN), false);
});

test("ohne Kurzkennung und ohne Compose-Projekt sperrt nichts", () => {
  assert.equal(isHubOwnStack(HUB_POSTGRES, ALL, null), false);
  assert.equal(isHubOwnStack(entry(`${OWN}dddd`, null), ALL, OWN), false);
});

test("derselbe Projektname auf einem ANDEREN Arm ist nicht der eigene", () => {
  // Die Liste ist immer die EINES Arms. Auf einem Arm ohne den Hub trägt
  // kein Container die eigene Kennung — auch nicht bei gleichem Projektnamen.
  const elsewhere = entry("99ff00ee11dd22cc33bb44aa55996688776655443322110099ff00ee11dd22cc", "docklet-hub");
  assert.equal(isHubOwnStack(elsewhere, [elsewhere], OWN), false);
});
