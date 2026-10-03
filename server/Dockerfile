# Image des Hubs: Server-API und gebaute Weboberfläche in einem Container.
#
# Warum beides zusammen und kein zweiter Dienst mit nginx: das
# Abnahmekriterium dieser Phase nennt drei laufende Dienste (Hub, Postgres,
# Agent). Ein vierter nur zum Ausliefern statischer Dateien wäre ein Dienst
# mehr, den ein fremder Betreiber verstehen, betreiben und im Fehlerfall
# einordnen müsste — für Dateien, die der Server ohnehin ausliefern kann.
#
# Das Basisimage ist auf Tag UND Digest gepinnt (AGENTS.md, „Abhängigkeiten
# und Images"). Digest abgerufen am 2026-10-03.
#
# Node 24 und nicht 22: die 22er Linie ist seit 2025-10-21 im Wartungsmodus
# (nur noch Sicherheits- und kritische Korrekturen) und endet 2027-04-30, die
# 24er ist die aktive LTS bis 2028-04-30. Quelle: nodejs/Release, schedule.json,
# abgerufen am 2026-09-01.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build

# Corepack zieht die in package.json gepinnte pnpm-Fassung. Ohne die
# Abschaltung der Rückfrage bleibt der Bau an einer Eingabeaufforderung stehen,
# die in einem Docker-Bau niemand beantworten kann.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

WORKDIR /app

# Erst die Manifeste, dann der Rest: solange sich keine Abhängigkeit ändert,
# bleibt diese Schicht im Cache und der Bau überspringt die Installation.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY contract/package.json contract/
COPY server/package.json server/
COPY web/package.json web/
COPY agent/package.json agent/
# Das `prepare`-Skript der Wurzel (`scripts/setup-git-hooks.mjs`) läuft bei
# jedem Install, der wirklich installiert — also genau hier. Es kommt mit einem
# Bau ohne `.git` zurecht, aber nur, wenn die Datei überhaupt da ist: fehlt sie,
# bricht Node mit „Cannot find module" ab, bevor das Skript seine eigene Prüfung
# erreicht, und der ganze Bau scheitert. Sie gehört deshalb vor den Install und
# nicht erst in das `COPY . .` darunter.
COPY scripts/setup-git-hooks.mjs scripts/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

# Entwicklungsabhängigkeiten wieder entfernen. Sie haben ihre Arbeit getan
# (tsc, vite) und hätten im Laufzeitimage nur Angriffsfläche und Gewicht.
#
# `--config.confirm-modules-purge=false` ist Pflicht und keine Bequemlichkeit:
# pnpm 11 räumt `node_modules` für diesen Wechsel komplett aus und fragt vorher
# nach. In einem Docker-Bau gibt es kein TTY, in dem jemand antworten könnte —
# pnpm bricht dann mit `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` ab, und der
# Bau stirbt in der letzten Zeile der Bau-Stufe.
RUN pnpm install --frozen-lockfile --prod --config.confirm-modules-purge=false


FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS runtime

ENV NODE_ENV=production
# Der Port steht im Image, damit der Healthcheck unten denselben Wert benutzt
# wie der Server. Compose reicht ihn ohnehin durch; ohne diese Vorgabe prüfte
# der Healthcheck bei geändertem PORT eine Adresse, an der niemand lauscht,
# und der Container gälte dauerhaft als krank.
ENV PORT=8080
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist

# The shared package, built. `server/node_modules/contract` is a workspace
# link to `../../contract`; without the target the hub dies at its first
# import. Only `dist`, never `src`: the hub runs without the `source`
# condition, so `contract` resolves through `default` to `dist/index.js`.
COPY --from=build /app/contract/package.json ./contract/package.json
COPY --from=build /app/contract/node_modules ./contract/node_modules
COPY --from=build /app/contract/dist ./contract/dist

# ⚠️ Die Migrationen müssen von Hand mitkopiert werden: `tsc` übersetzt
# TypeScript und rührt .sql-Dateien nicht an. Ohne diese Zeile startet der Hub
# mit einem leeren Migrationsverzeichnis — und legt damit ein leeres Schema an,
# ohne dass irgendetwas scheitert. Der Pfad entspricht dem, was migrate.ts
# relativ zu sich selbst auflöst.
COPY --from=build /app/server/src/platform/db/migrations ./server/dist/platform/db/migrations

# Die gebaute Oberfläche. Derselbe relative Pfad wie in der Arbeitskopie,
# damit index.ts sie in beiden Fällen über denselben Ausdruck findet.
COPY --from=build /app/web/dist ./web/dist

# Die eine Ausnahme von „nirgends Schreibrechte": das Verzeichnis, in das der
# Hub die Peer-Liste des Tunnels schreibt (wg0.conf, geteiltes Volume mit dem
# WireGuard-Sidecar).
#
# ⚠️ Diese Zeile steht hier und nicht in der docker-compose.yml, weil ein
# BENANNTES Volume Besitzer und Rechte beim ersten Start aus dem Image
# übernimmt. Fehlt das Verzeichnis im Image, legt Docker es als root:root 0755
# an — der Hub läuft als `node` (uid 1000) und kann darin nichts schreiben.
# Auffallen würde das erst beim Anlegen des ersten Arms, und dort sieht es nach
# einem Fehler im Hub aus statt nach einer fehlenden Zeile im Dockerfile.
# Compose kann das nicht nachholen: `chown` gibt es dort nicht.
RUN mkdir -p /etc/wireguard && chown node:node /etc/wireguard

# Der Hub braucht sonst nirgends Schreibrechte im Image — der Zustand liegt in
# Postgres. Der Benutzer `node` kommt aus dem Basisimage.
USER node

EXPOSE 8080

# Der Healthcheck steht im Image und nicht nur in der Compose-Datei: so trägt
# ihn jede Betriebsart, auch ein `docker run` ohne Compose.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD wget --spider -q "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server/dist/index.js"]
