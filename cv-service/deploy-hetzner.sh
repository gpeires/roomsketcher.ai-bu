#!/usr/bin/env bash
# Deploy CV service to a fresh Ubuntu server
# Usage: ./deploy-hetzner.sh <server-ip> [ssh-key-path]
set -euo pipefail

SERVER="${1:?Usage: ./deploy-hetzner.sh <server-ip> [ssh-key-path]}"
SSH_KEY="${2:-}"
SSH_OPTS="-o StrictHostKeyChecking=accept-new"
[ -n "$SSH_KEY" ] && SSH_OPTS="$SSH_OPTS -i $SSH_KEY"

REMOTE="root@$SERVER"
DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing Docker on $SERVER..."
ssh $SSH_OPTS "$REMOTE" bash -s <<'INSTALL'
set -euo pipefail
if command -v docker &>/dev/null; then
    echo "Docker already installed: $(docker --version)"
else
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources-docker.list
    cp /etc/apt/sources-docker.list /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
    echo "Docker installed: $(docker --version)"
fi

# Open port 8100 if ufw is active
if ufw status | grep -q "active"; then
    ufw allow 8100/tcp
    echo "Firewall: port 8100 opened"
fi
INSTALL

echo "==> Copying cv-service to server..."
rsync -avz --exclude='.venv' --exclude='__pycache__' --exclude='.pytest_cache' \
    -e "ssh $SSH_OPTS" \
    "$DIR/" "$REMOTE:/opt/cv-service/"

echo "==> Building and starting container..."
ssh $SSH_OPTS "$REMOTE" bash -s <<'START'
set -euo pipefail
cd /opt/cv-service
docker compose down 2>/dev/null || true
docker compose up --build -d
sleep 3
echo "==> Health check:"
curl -sf http://localhost:8100/health && echo ""
echo "==> Service is running!"
START

echo ""
echo "Done! CV service is live at: http://$SERVER:8100"
echo "Health: http://$SERVER:8100/health"
echo "Analyze: POST http://$SERVER:8100/analyze"
