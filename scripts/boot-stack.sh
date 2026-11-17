#!/bin/sh
# Start OpenWA + relay after boot (Docker inside WSL). Used by boot-stack.ps1.
set -e
OPENWA_DIR="${OPENWA_DIR:-/mnt/c/WhatsappAPI/openwa}"
RELAY_DIR="${RELAY_DIR:-/mnt/c/WhatsappAPI/relay}"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not in PATH" >&2
  exit 1
fi

# Docker Engine inside WSL (not Docker Desktop): start the daemon if the socket is missing.
if [ ! -S /var/run/docker.sock ]; then
  if command -v service >/dev/null 2>&1; then
    sudo service docker start 2>/dev/null || true
  fi
  sleep 2
fi
if [ ! -S /var/run/docker.sock ]; then
  echo "docker.sock missing — enable systemd + docker.service in WSL, or start dockerd" >&2
  exit 1
fi

cd "$OPENWA_DIR"
docker compose -f docker-compose.dev.yml up -d

cd "$RELAY_DIR"
docker compose up -d

docker ps --filter name=openwa --format 'table {{.Names}}\t{{.Status}}'