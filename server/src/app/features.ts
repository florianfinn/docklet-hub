import type { Router } from "express";

import { createRuntimeSettingsSync } from "./runtime-settings.js";
import type { ApiOptions } from "./router-support.js";
import { registerAccountRoutes } from "../features/account/index.js";
import { readGlobalTheme, registerAppearanceRoutes } from "../features/appearance/index.js";
import { registerComposeRoutes } from "../features/compose/index.js";
import { readContainerViewSettings, registerContainersRoutes } from "../features/containers/index.js";
import { registerLifecycleRoutes } from "../features/lifecycle/index.js";
import { registerFileRoutes } from "../features/files/index.js";
import { registerHostRoutes } from "../features/hosts/index.js";
import { readLogSettings, registerLogRoutes } from "../features/logs/index.js";
import { readHostDecoration, registerMarkRoutes } from "../features/marks/index.js";
import { hostLoad, registerMetricsRoutes } from "../features/metrics/index.js";
import { registerLiveEventRoutes } from "../features/live-events/index.js";
import { registerResourcesRoutes } from "../features/resources/index.js";
import { readApplyComposeDefinition, readRuntimeSettings, readSelfHealingConfig, readSelfHealingSettings, registerSettingsRoutes } from "../features/settings/index.js";
import { registerRuntimeActionsRoutes } from "../features/runtime-actions/index.js";
import { registerShellRoutes } from "../features/shell/index.js";

// The static feature list of the server (docs/design/feature-architecture.md,
// section 2: in the server, `app` is this list, read by `app/router.ts`).
// Each entry registers the routes of one surface on the `/api` router.
//
// The order is behaviour, not layout: Express runs routes in the order they
// were registered, and moving an entry moves all of its routes against all
// others. It is the order the router used before this list (#249), and
// `app/router-routes.test.ts` compares the registered routes against it.
// The origin check is not an entry: `app/router.ts` mounts it before the
// first one.
//
// Every entry is the door of a feature, `features/<name>/index.ts`. During the
// rebuild (milestone "Umbau: Ordnung nach Features") each route group that
// used to stand under `api/routes/` was replaced by one, without changing its
// place in this list; with `metrics` (#283) the last group is gone.
//
// ⚠️ A feature that takes its routes out of SEVERAL old groups lands at the
// place of the first of them, and its other routes move up with it. The first
// such case is `logs` (#254): `PUT /settings/logs` came from the settings
// group and now registers right after the log stream.
// `app/router-routes.test.ts` names each such move. Only routes whose
// patterns cannot match the same request may move against each other: Express
// tries layers in order, and for two that can never match the same path and
// method the order decides nothing.

export type RegisterFeature = (router: Router, options: ApiOptions) => void;

export const FEATURES: readonly RegisterFeature[] = [
  // The feature `account`: the own session (`GET /setup`, `GET /session`,
  // `PUT /session/language`) and the account list (`GET /users`). It took the
  // place of the two groups `session-routes` and `user-routes` (#269), which
  // stood next to each other, so no route moved.
  registerAccountRoutes,
  // The feature `hosts`: list, read containers, create, fetch the archive,
  // remove, trigger the agent update. It took the place of the group
  // `host-routes` (#266), so no route moved.
  //
  // The load by containers (`hostLoad`, #214) is handed in HERE: a feature
  // imports nothing above `domain/`, and `features/metrics/container-load.ts` is
  // not there. This list is the app, where two surfaces are put together; the
  // load is the half of the feature `metrics` (#283) that `hosts` shows.
  (router, options) => registerHostRoutes(router, { ...options, hostLoad }),
  // The feature `metrics`: the stats of one container. Kept apart from the host
  // routes although the path starts with `/hosts`: the cut follows what a
  // route reads, not its prefix. It took the place of the group
  // `container-routes` (#283), so no route moved.
  registerMetricsRoutes,
  // The feature `logs`: the container log as a running stream and
  // `PUT /settings/logs`.
  registerLogRoutes,
  // The feature `files`: which directory of a container is shared (four
  // routes) and the files inside it (six). Four of its reading routes are in
  // `GET_ROUTES_WITH_EFFECT` and rely on the origin check mounted before this
  // list. It took the place of the two groups `share-routes` and
  // `file-routes`, which stood next to each other (#262), so no route moved.
  registerFileRoutes,
  // The feature `compose`: the compose file of a stack (read, preview, apply)
  // and its project `.env`. It took the place of the group `compose-routes`
  // (#264), so no route moved.
  registerComposeRoutes,
  // The feature `shell`: the stream that opens a session and the three routes
  // that work on an open one.
  //
  // ⚠️ The session register is state in memory and has to be ONE instance per
  // router. `registerShellRoutes` creates it, and this entry runs once per
  // `createApiRouter`, so the register lives exactly as long as the router;
  // `features/shell/routes.ts` says why.
  registerShellRoutes,
  (router, options) => registerRuntimeActionsRoutes(router, {
    ...options, readApplyDefinition: () => readApplyComposeDefinition(options.pool)
  }),

  registerLifecycleRoutes,
  // The feature `containers`: the page after sign-in (`GET /overview`) and the
  // write of the container view (`PUT /settings/containers`). It took the place
  // of the group `overview-routes` and of the group `container-view-routes`
  // (#282), which stood apart.
  //
  // The marks and the display of an arm are handed in HERE, as the load is
  // for `hosts`: `marks` is a feature of its own, and a feature imports no
  // other feature.
  //
  // ⚠️ `PUT /settings/containers` moved up from behind `PUT /settings/network`
  // to right behind `GET /overview`, in front of `GET /settings`; see
  // `MOVED_BY_FEATURES` in `app/router-routes.test.ts`.
  (router, options) =>
    registerContainersRoutes(router, {
      ...options,
      decorationFor: (record) => readHostDecoration(options.pool, record.id),
      readLifecycleSettings: async () => {
        const [runtime, healing] = await Promise.all([readRuntimeSettings(options.pool), readSelfHealingConfig(options.pool)]);
        return { applyDefinition: runtime.applyComposeDefinition, maintenanceDurationSeconds: healing.config.maintenanceDurationSeconds };
      }
    }),
  // The feature `settings`: `GET /settings` with every setting of the hub and
  // `PUT /settings/network`. It took the place of the group `settings-routes`
  // (#269), so no route moved.
  //
  // The settings of the other surfaces are handed in HERE as readers: a
  // feature imports no other feature, and this list is the app, where several
  // surfaces are put together (docs/design/feature-architecture.md, section 7).
  (router, options) =>
    registerSettingsRoutes(router, {
      ...options,
      selfHealingSync: options.selfHealingSync ?? createRuntimeSettingsSync(options),
      readers: {
        readTheme: () => readGlobalTheme(options.pool),
        readLogSettings: () => readLogSettings(options.pool),
        readContainerView: () => readContainerViewSettings(options.pool),
        readRuntime: () => readRuntimeSettings(options.pool),
        readSelfHealing: () => readSelfHealingSettings(options.pool)
      }
    }),
  // The feature `appearance`: the theme of the hub (`PUT /settings/theme`) and
  // the colour of an arm (`PUT /hosts/:hostId/display`). It took two of the
  // routes of the group `appearance-routes` (#268).
  registerAppearanceRoutes,
  // The feature `marks`: the stock of the own marks (list, create, change,
  // remove) and their assignment to a stack or a container, with the display
  // per stack. It took the other routes of `appearance-routes` and all of
  // `mark-assignment-routes` (#268).
  //
  // ⚠️ `GET /marks` moved down behind the two routes of `appearance`: the
  // theme and the colour of an arm used to stand between it and `POST /marks`.
  // No other registered pattern can match `GET /marks`, so the order changes no
  // answer; `app/router-routes.test.ts` holds that (`MOVED_BY_FEATURES`).
  registerMarkRoutes,
  // The feature `resources`: images, volumes and networks of one host (#10).
  // Its one pattern matches no other route, so its place moves nothing.
  registerResourcesRoutes,
  registerLiveEventRoutes
];
