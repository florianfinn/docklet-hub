#!/bin/sh
set -eu

config=/etc/wireguard/wg0.conf

cleanup() {
  wg-quick down "$config" >/dev/null 2>&1 || true
}

trap cleanup EXIT INT TERM
wg-quick up "$config"

# This process exists solely to keep the network namespace alive. The actual
# agent runs as a separate service with cap-drop=ALL in exactly this
# namespace; the NET_ADMIN sidecar never sees docker.sock.
tail -f /dev/null &
child=$!
wait "$child"
