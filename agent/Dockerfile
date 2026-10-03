# Image of the agent. Built from the repository root, because the lockfile and
# the workspace list live there:
#
#   docker build -f agent/Dockerfile .
#
# The base is pinned to tag and digest like the hub; Dependabot moves the
# digest within the `24-alpine` series, so patched bases still arrive.
#
# Node series, `.nvmrc` and `@types/node` change together; a test enforces it.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
# The version stands here AND in the `packageManager` field of the root
# package.json, so image and tool do not drift apart. Installed through npm
# rather than corepack: the corepack bundled with the base image is older than
# pnpm 11 and rejects its signature.
RUN npm install -g pnpm@11.21.0
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contract/package.json contract/
COPY agent/package.json agent/
# The root `prepare` script runs on every install that installs something.
# It copes with a build without `.git`, but only if the file is there.
COPY scripts/setup-git-hooks.mjs scripts/
# `--frozen-lockfile` installs EXACTLY what the lockfile holds and fails when
# lockfile and package.json disagree; a free install could build the release
# against other dependencies than the ones `pnpm run test` ran against. Only
# the agent and what it depends on are installed.
RUN pnpm install --frozen-lockfile --filter "agent..."
# The shared contract is built first (#272): the agent imports its schemas, and
# the image runs its built `dist`, never the TypeScript source.
COPY contract/tsconfig.json contract/tsconfig.build.json contract/
COPY contract/src contract/src
RUN pnpm --filter contract run build
COPY agent/tsconfig.json agent/tsconfig.build.json agent/
COPY agent/src agent/src
RUN pnpm --filter agent run build
# Down to what runs, in a tree of its own: zod, the one runtime dependency
# besides `contract` (pinned exactly, `web/tests/agent-package.test.mjs`), and
# the built contract with its manifest. Copied out of the workspace instead of
# a `--prod` install: the store under `/app/node_modules/.pnpm` also holds the
# root's development tools, and none of them belongs next to the socket.
# `cp -L` resolves pnpm's links, so the image carries files, not links into a
# store it does not have. The last line proves the tree loads on its own.
RUN mkdir -p /out/node_modules/contract \
 && cp -rL agent/node_modules/zod /out/node_modules/zod \
 && cp contract/package.json /out/node_modules/contract/ \
 && cp -r contract/dist /out/node_modules/contract/dist \
 && cd /out && node --input-type=module -e "await import('contract')"

FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
ENV NODE_ENV=production
# No install in the runtime layer, and no pnpm: the runtime dependencies are
# zod and the shared contract (#272), copied from the build stage as files.
# `web/tests/agent-package.test.mjs` fails on any other entry in
# `agent/package.json` and on a pin that is not exact. The contract arrives as
# its built `dist`, never as TypeScript source.
#
# docker-cli-compose is no such dependency: it is no Node package inside
# the process but a separate binary, called through execFile with an argument
# array (compose-cli.ts). It comes from the Alpine repository and is updated
# with the base image.
#
# The reason to need it at all: `docker compose` is not part of the engine
# API. Rebuilding it over the socket would duplicate Compose's naming, label
# and dependency logic: a second, slightly different reading of the same
# file. For a security question "almost the same reading" is the worst option.
RUN apk add --no-cache docker-cli docker-cli-compose wireguard-tools iproute2
# The base brings npm, npx and corepack, but this layer only calls `node`.
# What stays of them is no tool, only attack surface: npm bundles its OWN
# dependency tree under /usr/local/lib/node_modules/npm/node_modules, and that
# tree showed up in the weekly scan of the former agent repository with 9
# findings (tar, brace-expansion, ip-address, picomatch, sigstore) in code this
# image never runs. Rebuilding did not help, because the scan already built
# against the fresh base; only removing them does.
#
# The `command -v` check is not decoration: if the base renames these paths
# one day, `rm -rf` silently hits nothing, the tree is back, and the line still
# claims it removed it. Then the build shall fail, not the next scan.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
 && ! command -v npm > /dev/null \
 && ! command -v corepack > /dev/null \
 && node --version > /dev/null
COPY agent/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/agent/dist ./dist
COPY agent/wireguard-sidecar.sh /usr/local/bin/wireguard-sidecar
# /state MUST be created here, with the right owner. Docker takes over the
# permissions of the image directory when it creates a named volume for the
# first time. Without the directory in the image the volume belongs to root,
# and the process running as `node` cannot write its audit log. That is what
# happened in the first smoke test.
RUN mkdir -p /state && chown node:node /state && chmod 0755 /usr/local/bin/wireguard-sidecar
VOLUME /state
# Do not run as root. Access to the socket is granted through group membership
# (group_add in docker-compose.yml), not through root inside the container.
USER node
CMD ["node", "dist/index.js"]
