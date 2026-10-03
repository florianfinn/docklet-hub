#!/bin/sh
# Erzeugt die .env für den Stack — einmal vor dem ersten `docker compose up`.
#
# Zweck: ein frischer Betrieb verlangt KEINE Eingabe. Geheimnisse werden
# gewürfelt, die Docker-GID wird am Socket abgelesen. Wer diesen Stack in einem
# fremden Netz hochfährt, muss nichts über dieses Netz wissen und nichts
# nachschlagen.
#
# Das Skript ist wiederholbar: ein bereits vorhandener Wert wird NIE
# überschrieben. Ein zweiter Aufruf ergänzt nur, was fehlt — er würfelt keine
# neuen Geheimnisse und sperrt damit niemanden aus seiner eigenen Datenbank aus.
#
# POSIX sh, keine Bash-Erweiterungen: auf einer frischen Maschine ist nicht
# gesetzt, dass /bin/sh eine Bash ist.
set -eu

WURZEL="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DATEI="$WURZEL/.env"
DOCKER_SOCKET="${DOCKER_SOCKET:-/var/run/docker.sock}"

# ---------------------------------------------------------------------------
# Hilfsmittel
# ---------------------------------------------------------------------------

# Liest einen bereits gesetzten Wert aus der .env. Leer, wenn er fehlt.
lies_wert() {
  [ -f "$ENV_DATEI" ] || return 0
  sed -n "s/^$1=//p" "$ENV_DATEI" | head -n 1 | tr -d '\r'
}

# Schreibt einen Wert, aber nur, wenn er noch nicht dasteht.
setze_wert() {
  name="$1"
  wert="$2"
  herkunft="$3"
  vorhanden="$(lies_wert "$name")"
  if [ -n "$vorhanden" ]; then
    echo "  $name — bleibt unverändert"
    return 0
  fi
  printf '%s=%s\n' "$name" "$wert" >>"$ENV_DATEI"
  echo "  $name — $herkunft"
}

# Ein Geheimnis in Hex. Bewusst Hex und nicht base64: der Wert landet unter
# anderem in einer postgres://-URL, und dort wären +, / und = Zeichen mit
# eigener Bedeutung. 64 Hexzeichen liegen deutlich über den 32, die Hub und
# Agent beide mindestens verlangen.
wuerfle_geheimnis() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  else
    echo "Weder openssl noch /dev/urandom vorhanden — es lässt sich kein Geheimnis erzeugen." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Docker-GID: abgelesen, nicht geraten
# ---------------------------------------------------------------------------
#
# Sie unterscheidet sich je Distribution (Debian üblicherweise 999, andere 998,
# Arch oft 970). Ein geratener Wert führt zu einem Agenten, der startet und den
# Socket dann nicht lesen darf — ein Fehlerbild, das nach „Docker kaputt"
# aussieht und keines ist.
ermittle_docker_gid() {
  if [ ! -S "$DOCKER_SOCKET" ]; then
    echo "Kein Docker-Socket unter $DOCKER_SOCKET." >&2
    echo "Läuft Docker auf diesem Host? Liegt der Socket anderswo, hilft DOCKER_SOCKET=/pfad/zum/socket $0" >&2
    exit 1
  fi
  # GNU (Linux) zuerst, BSD/macOS als Rückfall.
  stat -c '%g' "$DOCKER_SOCKET" 2>/dev/null || stat -f '%g' "$DOCKER_SOCKET"
}

# ---------------------------------------------------------------------------
# WireGuard-Schlüsselpaar des Hubs
# ---------------------------------------------------------------------------
#
# Gebraucht wird es erst beim Anbinden eines Hosts außerhalb dieses Rechners —
# der lokale Agent im selben Compose-Netz kommt ohne Tunnel aus. Es entsteht
# trotzdem hier: ein Schlüssel, der beim ersten Bedarf erzeugt wird, ist ein
# Schritt, der genau dann anfällt, wenn jemand etwas anderes vorhat.
#
# `wg` ist der Regelweg. Fehlt es — und auf einer frischen Maschine fehlt es
# meistens —, erzeugt openssl dasselbe: WireGuard-Schlüssel sind rohe
# X25519-Schlüssel in base64. Aus der DER-Kodierung sind es jeweils die letzten
# 32 Bytes.
erzeuge_wireguard_paar() {
  if command -v wg >/dev/null 2>&1; then
    WG_PRIVAT="$(wg genkey)"
    WG_OEFFENTLICH="$(printf '%s' "$WG_PRIVAT" | wg pubkey)"
    WG_HERKUNFT="erzeugt mit wg"
  elif command -v openssl >/dev/null 2>&1; then
    tmp="$(mktemp)"
    openssl genpkey -algorithm X25519 -outform DER -out "$tmp" 2>/dev/null
    WG_PRIVAT="$(tail -c 32 "$tmp" | base64 | tr -d '\n')"
    WG_OEFFENTLICH="$(openssl pkey -inform DER -in "$tmp" -pubout -outform DER 2>/dev/null | tail -c 32 | base64 | tr -d '\n')"
    rm -f "$tmp"
    WG_HERKUNFT="erzeugt mit openssl"
  else
    echo "Weder wg noch openssl vorhanden — es lässt sich kein WireGuard-Schlüsselpaar erzeugen." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Ablauf
# ---------------------------------------------------------------------------

if [ ! -f "$ENV_DATEI" ]; then
  printf '# Erzeugt von scripts/bootstrap.sh. Enthält Geheimnisse — gehört nicht ins Repo.\n' >"$ENV_DATEI"
fi
# Vor dem Schreiben der Werte: die Datei trägt gleich Geheimnisse.
chmod 600 "$ENV_DATEI"

echo "Schreibe $ENV_DATEI"

setze_wert "DOCKER_GID" "$(ermittle_docker_gid)" "abgelesen an $DOCKER_SOCKET"
setze_wert "POSTGRES_PASSWORD" "$(wuerfle_geheimnis)" "gewürfelt"
setze_wert "DOCKER_AGENT_SECRET" "$(wuerfle_geheimnis)" "gewürfelt"
setze_wert "BETTER_AUTH_SECRET" "$(wuerfle_geheimnis)" "gewürfelt"

# Das Schlüsselpaar nur erzeugen, wenn wirklich etwas fehlt — sonst liefe bei
# jedem Aufruf ein Schlüsselpaar ins Leere.
if [ -z "$(lies_wert HUB_WIREGUARD_PRIVATE_KEY)" ] || [ -z "$(lies_wert HUB_WIREGUARD_PUBLIC_KEY)" ]; then
  erzeuge_wireguard_paar
  setze_wert "HUB_WIREGUARD_PRIVATE_KEY" "$WG_PRIVAT" "$WG_HERKUNFT"
  setze_wert "HUB_WIREGUARD_PUBLIC_KEY" "$WG_OEFFENTLICH" "$WG_HERKUNFT"
else
  echo "  HUB_WIREGUARD_PRIVATE_KEY — bleibt unverändert"
  echo "  HUB_WIREGUARD_PUBLIC_KEY — bleibt unverändert"
fi

echo
echo "Fertig. Weiter mit:"
echo "    docker compose up -d"
