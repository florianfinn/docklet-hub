// The calls of the feature `hosts` (#267): the agent update of an arm (#7), the
// containers of an arm for the counters, creating and removing an arm and the
// address of its archive. Until #267 the update was `web/src/api/agent-update.ts`
// and the rest stood in `web/src/api/client.ts`; a feature imports nothing from
// `web/src/api/`, so the calls moved along.
//
// Das Update des Agenten eines Arms über dessen Watcher (#7) — die beiden
// Routen unter `/api/hosts/:hostId/agent-update` (server/src/features/
// hosts/routes.ts).
//
// ⚠️ `202` HEISST ANGENOMMEN, NICHT ERLEDIGT. Den Tausch führt der Watcher auf
// dem Arm aus; während er läuft, antwortet der Agent nicht, und der Stand ist
// erst danach wieder lesbar. Die Oberfläche fragt deshalb nach, bis der letzte
// Lauf des Arms die Auftragsnummer trägt, die dieser Aufruf zurückgab.

import { hostContainersSchema, hostResponseSchema, type HostContainers } from "contract";

import type { DockerHost } from "../../domain/hosts";
import { parseResponse, postJson, request, requestNoContent } from "../../platform/http/transport";

export type AgentUpdateAccepted = { jobId: string; targetVersion: string };

// Spiegelt `SelfUpdateStatus` in server/src/domain/hosts/self-update.ts. `outcome`
// ist eine Zeichenkette und keine Aufzählung: der Wert kommt wörtlich vom
// Watcher, und ein neuer Ausgang soll hier ankommen statt zu verschwinden.
export type AgentUpdateLastRun = {
  jobId: string;
  outcome: string;
  reason: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  finishedAt: string | null;
};

export type AgentUpdateStatus = {
  running: boolean;
  version: string | null;
  last: AgentUpdateLastRun | null;
};

export function startAgentUpdate(hostId: string): Promise<AgentUpdateAccepted> {
  return postJson(`/api/hosts/${encodeURIComponent(hostId)}/agent-update`, {});
}

export function fetchAgentUpdateStatus(hostId: string): Promise<AgentUpdateStatus> {
  return request(`/api/hosts/${encodeURIComponent(hostId)}/agent-update`);
}

export async function fetchHostContainers(hostId: string): Promise<HostContainers> {
  const path = `/api/hosts/${encodeURIComponent(hostId)}/containers`;
  return parseResponse(path, hostContainersSchema, await request(path));
}

// `kind` ist hier auf `internal | external` eingeschränkt: `local` gibt es
// genau einmal und wird eingetragen, nicht angelegt (§4).
// ⚠️ The `{ host }` envelope is unpacked here. Until D7a (#82) this function
// promised a bare `DockerHost` while `POST /api/hosts` answered with
// `{ host: … }`; the blind cast in `request<T>` hid it, and a new arm stood in
// the list with `id: undefined` until a reload. Since #248 the response is
// parsed against `hostResponseSchema`, and a wrong envelope fails here with
// path and field instead of reaching the list.
export async function createHost(input: {
  name: string;
  kind: "internal" | "external";
  // Die zwei Werte des ZIELHOSTS, seit 008 Pflicht beim Anlegen: die Gruppe
  // seines Docker-Sockets und der Pfad, unterhalb dessen seine Compose-
  // Projekte liegen. Sie gehen in das Paket, das dieser Arm bekommt — der Hub
  // kann beide nicht selbst herausfinden.
  //
  // ⚠️ `number` und nicht `string`: 0 ist die Gruppe root und ein gültiger
  // Wert. Ein leeres Feld darf hier gar nicht erst ankommen, sonst wird aus
  // „nichts eingetragen" auf dem Weg eine 0.
  dockerGid: number;
  bindBasePath: string;
  endpointOverride: string | null;
}): Promise<DockerHost> {
  const { host } = parseResponse("/api/hosts", hostResponseSchema, await postJson("/api/hosts", input));
  return host;
}

export function deleteHost(hostId: string): Promise<void> {
  return requestNoContent(`/api/hosts/${encodeURIComponent(hostId)}`, { method: "DELETE" });
}

// Kein `fetch` + Blob: das verliert den Dateinamen aus `Content-Disposition`
// und in manchen Browsern die Cookie-Sitzung. Diese Adresse ist für ein
// <a download>-Element gedacht, das die Sitzung wie jede andere Navigation
// mitschickt.
export function hostArchiveUrl(hostId: string): string {
  return `/api/hosts/${encodeURIComponent(hostId)}/archive`;
}
