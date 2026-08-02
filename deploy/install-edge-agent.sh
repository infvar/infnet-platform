#!/usr/bin/env sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "run as root" >&2
  exit 1
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
binary=${1:-"$repo_dir/dist/infnet-edge-agent"}

if [ ! -x "$binary" ]; then
  echo "edge-agent binary not found or not executable: $binary" >&2
  echo "build it with: make build-edge" >&2
  exit 1
fi

if ! getent group infnet >/dev/null 2>&1; then groupadd --system infnet; fi
if ! id infnet >/dev/null 2>&1; then useradd --system --gid infnet --home-dir /var/lib/infnet --shell /usr/sbin/nologin infnet; fi

install -d -o infnet -g infnet -m 0750 /opt/infnet-edge-agent /var/lib/infnet /etc/infnet
install -o root -g root -m 0755 "$binary" /opt/infnet-edge-agent/edge-agent
install -o root -g root -m 0644 "$repo_dir/services/edge-agent/infnet-edge-agent.service" /etc/systemd/system/infnet-edge-agent.service

if [ ! -f /etc/infnet/edge-agent.env ]; then
  install -o root -g root -m 0600 "$script_dir/edge-agent.env.example" /etc/infnet/edge-agent.env
  echo "edit /etc/infnet/edge-agent.env, install TLS files, then run:" 
  echo "  systemctl daemon-reload && systemctl enable --now infnet-edge-agent"
else
  echo "kept existing /etc/infnet/edge-agent.env"
fi
