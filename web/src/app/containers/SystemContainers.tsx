import { SystemContainersPanel } from "../../features/containers";
import type { Role } from "../../platform/session/session-user";
import { useDeepDiveSlots } from "./container-slots";

// The tab "Hub & Agenten": the list of the deep dive with the containers of the
// hub itself. Its own component because the places for marks and usage need a
// hook (`useDeepDiveSlots`), and a tab renders through a plain function that
// may not call one.
export function SystemContainers({ role }: { role: Role }) {
  return <SystemContainersPanel slots={useDeepDiveSlots(role)} />;
}
