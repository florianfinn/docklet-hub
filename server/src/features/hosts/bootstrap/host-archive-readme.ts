import { DEFAULT_BIND_BASE_PATH, type HostArchiveInput } from "./host-archive-input.js";

// Die README im Archiv. Ihr Text ist ENGLISCH, die Kommentare hier bleiben
// deutsch (AGENTS.md, „Sprache", die Ausnahmeliste; entschieden am 2026-09-09
// in #92). Der Grund steht in der Datei, die sie beschreibt: dieses Paket wird
// auf einem fremden Host ausgepackt, und wer es dort liest, ist nicht
// zwingend der, der den Hub bedient. Bis dahin galt hier das Gegenteil, mit
// derselben Begründung und der umgekehrten Annahme über den Leser.
//
// ⚠️ `registered` and `given-up` are the agent's values in `/health`, quoted
// verbatim so the reader can find them in the output. Until #278 they were
// German, and the text named the English meaning next to them.
//
// ⚠️ Sie nennt AUSSCHLIESSLICH Handgriffe auf dem Zielhost und beobachtbare
// Ausgaben dort. Keine Aussage darüber, was der Hub anzeigt: diese Datei liegt
// nach dem Entpacken auf einem fremden Rechner und altert dort, während der
// Hub weiterläuft. Ein Satz wie „danach steht der Host auf grün" wäre morgen
// falsch, ohne dass es jemand merkt.

// Ein Vorschlag, kein Zwang — deshalb steht er einmal hier und nirgends im
// Compose: dort würde ein anderer Ablageort zu einem Widerspruch.
//
// ⚠️ Der Vorschlag setzt voraus, dass `/` einen Neustart überlebt, und das tut
// er nicht überall. Gemessen am 2026-09-06 auf einem unraid 6.12: `findmnt -no
// FSTYPE,SOURCE /` meldet dort `rootfs rootfs` — die Wurzel liegt im RAM und
// wird bei jedem Start neu vom Flash-Stick aufgebaut. Ein Arm unter /opt wäre
// nach dem nächsten Neustart weg, mitsamt seinem privaten Schlüssel, und ein
// zweites Exemplar des Archivs gibt es nicht. Deshalb steht die Anforderung
// jetzt im Text neben dem Pfad, und nicht nur der Pfad.
const SUGGESTED_DIRECTORY = "/opt/docklet-agent";

// Der Name des Verzeichnisses, das der Arm bekommt — unterhalb des Pfades, den
// der Betreiber beim Anlegen genannt hat.
const DIRECTORY_NAME = "docklet-agent";

// Die Gegenprobe auf eine Wurzel, die den Neustart NICHT übersteht.
//
// ⚠️ Sie steht in BEIDEN Fassungen unten, und das ist eine Korrektur an einem
// eigenen Fehlgriff. Der erste Entwurf ließ sie weg, sobald der Hub das
// Arbeitsverzeichnis kennt — mit der Begründung, der Betreiber habe mit dieser
// Angabe ja bereits einen dauerhaften Ort benannt. Das ist eine Zusage über
// einen FREMDEN Host, die diese Datei nicht halten kann: das Feld fragt nach
// dem Ort der Compose-Projekte und nicht nach einem Datenträger, und nichts
// hindert jemanden daran, dort `/opt/docker` einzutragen. Der Wächter
// „die README verlangt einen Ablageort, der einen Neustart überlebt" hat den
// Entwurf abgewiesen, und er hatte recht.
//
// Der bekannte Pfad macht den VORSCHLAG besser. Er macht die Prüfung nicht
// überflüssig.
const PERSISTENCE_CHECK = [
  "   ```bash",
  "   findmnt -no FSTYPE,SOURCE /",
  "   ```",
  ""
];

/**
 * Wohin das Archiv gehört — und der Satz, der davorsteht.
 *
 * ⚠️ ZWEI FASSUNGEN, aus demselben Grund wie bei `gidStep`. Kennt der Hub das
 * Arbeitsverzeichnis dieses Hosts (seit #89 fragt der Dialog danach), steht der
 * Vorschlag dort statt unter `/opt` — das ist der Ort, an dem die
 * Compose-Projekte dieses Hosts ohnehin liegen. Kennt er es nicht — ein Arm aus
 * der Zeit davor —, bleibt `/opt`.
 *
 * Gemessen am 2026-09-06 auf einem unraid 6.12: `findmnt -no FSTYPE,SOURCE /`
 * meldet dort `rootfs rootfs`, die Wurzel liegt im RAM, und ein Arm unter
 * `/opt` wäre nach dem nächsten Neustart weg — mitsamt seinem privaten
 * Schlüssel, den dieser Hub nicht noch einmal ausliefern kann.
 *
 * ⚠️ Der Pfad hier und der Vorschlag im Anlege-Dialog müssen DASSELBE
 * Verzeichnis nennen. Der Dialog sagt „lege es hier an", das Paket sagt „hier
 * liegt es" — nennen beide verschiedene Orte, sucht der Betreiber im zweiten
 * Schritt an einer Stelle, an der nichts ist. `web/tests/host-form-defaults.test.mjs`
 * hält die beiden Zeichenketten gegeneinander.
 */
function unpackStep(bindBasePath: string | null): { directory: string; lines: string[] } {
  if (bindBasePath === null) {
    return {
      directory: SUGGESTED_DIRECTORY,
      lines: [
        "   WARNING: on appliance systems such as unraid, `/` lives in RAM and is",
        "   rebuilt on every boot; the suggestion below would be gone after the",
        "   next restart. The cross-check, before unpacking:",
        "",
        ...PERSISTENCE_CHECK,
        "   If that prints `rootfs`, `tmpfs` or `overlay`, the directory belongs on",
        "   persistent storage — on unraid below `/mnt/user/appdata/`. That path is",
        "   then the one to use in every step that follows: the commands stay the",
        "   same otherwise.",
        ""
      ]
    };
  }
  return {
    directory: `${bindBasePath}/${DIRECTORY_NAME}`,
    lines: [
      "   The location below sits under the working directory entered for this",
      "   host when it was created in the hub — where this host's compose projects",
      "   already live.",
      "",
      "   WARNING: the hub does not know whether that location survives a restart;",
      "   the question was where the projects live, not which storage they are on.",
      "   On appliance systems such as unraid, `/` lives in RAM. The cross-check,",
      "   before unpacking — it has to hit the path below and not the root:",
      "",
      ...PERSISTENCE_CHECK,
      "   If that prints `rootfs`, `tmpfs` or `overlay`, use `df -h` to check which",
      "   storage the path below really sits on. If it belongs to the root, the",
      "   directory belongs elsewhere — on unraid below `/mnt/user/appdata/`. The",
      "   commands stay the same otherwise.",
      ""
    ]
  };
}

// `nc` will Adresse und Port getrennt. Der Endpoint kommt als `host:port` —
// und bei IPv6 als `[::1]:port`, weshalb am LETZTEN Doppelpunkt getrennt wird
// und nicht am ersten.
function splitEndpoint(endpoint: string): string {
  const separator = endpoint.lastIndexOf(":");
  return separator < 0 ? endpoint : `${endpoint.slice(0, separator)} ${endpoint.slice(separator + 1)}`;
}

// Schritt 2 hat zwei Fassungen, und der Unterschied ist der Punkt: kennt der
// Hub die Gruppen-ID (seit 008 wird sie beim Anlegen abgefragt), steht sie
// schon in der `.env` und der Leser prüft sie nur nach. Kennt er sie nicht —
// ein Arm aus der Zeit davor —, bleibt der Handgriff.
//
// ⚠️ Beide Fassungen nennen denselben Befehl. Ein „ist schon eingetragen"
// ohne Gegenprobe wäre eine Zusage über einen fremden Host, die diese Datei
// nicht halten kann: der Socket dort gehört, wem er gehört, und nicht dem,
// was jemand vor Tagen in ein Formular geschrieben hat.
function gidStep(dockerGid: number | null): string[] {
  const command = "stat -c %g /var/run/docker.sock";
  if (dockerGid === null) {
    return [
      "2. **Enter the group id of the Docker socket.** It is the one value the hub",
      "   does not know. Without it the stack does not start.",
      "",
      "   ```bash",
      `   ${command}`,
      `   sudo sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$(${command})/" .env`,
      "   ```",
      "",
      "   WARNING: this reads the socket, not the `docker` group. On many hosts",
      "   the two mean the same thing; that is not something to rely on. Where no",
      "   group of that name exists, `getent group docker` stays silently empty;",
      "   where the socket belongs to another group, it prints the wrong number.",
      "   The socket itself knows in both cases."
    ];
  }
  return [
    "2. **Check the group id of the Docker socket.** It is already in the",
    `   \`.env\`: \`DOCKER_GID=${dockerGid}\` — entered when this host was created`,
    "   in the hub. Does it match this host?",
    "",
    "   ```bash",
    `   ${command}`,
    "   ```",
    "",
    "   If the command prints a different number, that one applies: enter it in",
    "   the `.env`, otherwise the agent may not read the socket.",
    "",
    "   ```bash",
    `   sudo sed -i "s/^DOCKER_GID=.*/DOCKER_GID=$(${command})/" .env`,
    "   ```"
  ];
}

export function renderReadme(input: HostArchiveInput): string {
  const address = input.host.tunnelAddress;
  const port = input.agent.port;
  const unpack = unpackStep(input.host.bindBasePath);
  const lines = [
    `# Docker agent for ${input.host.name}`,
    "",
    "This archive was generated by the dashboard hub for this host and no other.",
    "It contains the private WireGuard key, the agent secret and a one-time",
    "registration token.",
    "",
    "WARNING: there is no second copy. The hub does not store the private key and",
    "cannot hand out the same archive again — downloading it once more generates a",
    "NEW package with new keys and locks out the installation running here.",
    "",
    "## What this host gets",
    "",
    `- Tunnel address: \`${address}\`, tunnel network \`${input.hub.tunnelCidr}\``,
    `- Far end: \`${input.hub.endpoint}\` (UDP)`,
    `- Three containers: \`wireguard\` (tunnel), \`docker-agent\`, \`watcher\` (updates)`,
    "",
    "## Step by step",
    "",
    "Every command runs on THIS host. `sudo` appears wherever `docker` is",
    "normally owned by root here; if you run Docker as an ordinary user, leave",
    "it out.",
    "",
    "1. **Create the directory and put the archive in it.** The location has to",
    "   survive a restart — the private key and the agent secret live here, and",
    "   there is no second copy of the archive.",
    "",
    ...unpack.lines,
    "   ```bash",
    `   sudo mkdir -p ${unpack.directory}`,
    `   sudo tar -xzf <archive>.tar.gz -C ${unpack.directory}`,
    `   cd ${unpack.directory}`,
    "   ```",
    "",
    ...gidStep(input.host.dockerGid),
    "",
    "3. **Set the file permissions.** `.env` and `wg0.conf` carry secrets; any",
    "   user who can read them can impersonate this host.",
    "",
    "   ```bash",
    "   sudo chown root:root .env wg0.conf docker-compose.yml README.md",
    "   sudo chmod 600 .env wg0.conf",
    "   sudo chmod 644 docker-compose.yml README.md",
    "   ```",
    "",
    "4. **Cross-check before the start.** The command resolves every variable",
    "   and reports the missing ones before a single container runs.",
    "",
    "   ```bash",
    "   sudo docker compose config >/dev/null && echo ok",
    "   ```",
    "",
    "5. **Start.**",
    "",
    "   ```bash",
    "   sudo docker compose up -d",
    "   ```",
    "",
    "## How to tell that it worked",
    "",
    "Three things, in this order. Each of them can be read here on the host and",
    "needs no look from outside.",
    "",
    "1. **The containers are running.** `wireguard` and `docker-agent` are",
    "   `healthy`, not merely `running`.",
    "",
    "   ```bash",
    "   sudo docker compose ps",
    "   ```",
    "",
    "2. **The tunnel is up.** `latest handshake` carries a timestamp and",
    "   `transfer` counts in both directions.",
    "",
    "   ```bash",
    "   sudo docker compose exec wireguard wg show wg0",
    "   ```",
    "",
    "3. **Registration went through.** The agent reports its state in `/health`",
    "   under `bootstrap`. The call runs inside the tunnel's network namespace",
    "   and therefore goes through `exec`, not from the host.",
    "",
    "   ```bash",
    `   sudo docker compose exec docker-agent wget -qO- http://${address}:${port}/health`,
    "   ```",
    "",
    "   `\"phase\":\"registered\"` is the target state. Anything else",
    "   means it is still trying; the agent retries for up to fifteen minutes.",
    "   `\"given-up\"` means it gave up: registration is over, see below.",
    "",
    "## If something does not start",
    "",
    "In order, from the bottom up:",
    "",
    "- **`DOCKER_GID is missing`** on `up`: step 2 was skipped.",
    "- **`permission denied` on `/var/run/docker.sock`**: the group id entered is",
    "  not the group that owns the socket (`ls -l /var/run/docker.sock`).",
    "- **`wireguard` never turns `healthy`**: logs with",
    "  `sudo docker compose logs wireguard`. If `wg-quick` reports an invalid",
    "  key, `wg0.conf` was damaged while copying. If the kernel module is",
    "  missing, `sudo modprobe wireguard` helps.",
    "- **The handshake stays empty**: the far end's UDP port cannot be reached",
    `  from here. Cross-check: \`nc -vzu ${splitEndpoint(input.hub.endpoint)}\`.`,
    "  The most common cause is a firewall on the way, not these files.",
    "- **`docker-agent` starts and exits immediately**: logs with",
    "  `sudo docker compose logs docker-agent`. The agent names the reason in",
    "  plain words and stops rather than running half-way. Typical causes are a",
    "  `DOCKER_AGENT_SECRET` that is too short or a missing",
    "  `DOCKER_AGENT_TUNNEL_CIDR` in the `.env` — either one means the file was",
    "  changed after unpacking.",
    `- **Bind mounts are rejected**: the agent allows them below`,
    `  \`${input.host.bindBasePath ?? DEFAULT_BIND_BASE_PATH}\` only. If this host's compose projects live`,
    "  somewhere else, that path belongs in `DOCKER_AGENT_BIND_BASE_PATH`, and",
    "  the stack has to be restarted once afterwards.",
    "- **`\"phase\":\"given-up\"`**: the registration token is spent or was refused.",
    "  A restart does not help then — the way back is a new archive from the",
    "  dashboard, which replaces this installation completely.",
    "",
    "## Afterwards",
    "",
    "Delete the downloaded `.tar.gz` once the stack is running: it carries the",
    "same secrets as the unpacked files, but without their permissions.",
    "",
    "Agent updates run through the `watcher`. The dashboard's host list offers",
    "*Update agent* when the agent it pins is newer than this one; the watcher",
    "then pulls, verifies the signature and swaps the agent. It does NOT swap",
    "itself in the process — that takes a `sudo docker compose up -d` with a",
    "newer `DOCKER_AGENT_IMAGE`.",
    "",
    "The swap leaves `.env` untouched. Set `DOCKER_AGENT_IMAGE` there to the",
    "new reference before the next `sudo docker compose up -d` — otherwise that",
    "command puts the agent back on the image `.env` still names.",
    "",
    "## Moving an older installation to this agent",
    "",
    "A host that already runs an agent from an earlier release — one that was",
    "installed before the agent moved into the hub's repository, or one that",
    "speaks an older protocol — keeps running, but the hub cannot manage it",
    "until it has been moved. The old agent",
    "cannot follow the new image name by itself, so the step is done once, by",
    "hand, in the directory of the existing installation:",
    "",
    "1. Read the image line of THIS package. It is the reference the hub pins",
    "   for agents; the copy in this package's `.env` is the one that counts.",
    "",
    "   ```bash",
    "   grep '^DOCKER_AGENT_IMAGE=' .env",
    "   ```",
    "",
    "2. In the `.env` of the existing installation, replace its",
    "   `DOCKER_AGENT_IMAGE=` line with that one.",
    "",
    "3. Restart the stack there:",
    "",
    "   ```bash",
    "   sudo docker compose up -d",
    "   ```",
    "",
    "Only the image line changes: keys, secrets and the tunnel stay as they are,",
    "and the installation does not need a new archive for this."
  ];
  return lines.join("\n") + "\n";
}
