#!/usr/bin/env bash
# linux-setup.sh — set up the headless Linux laptop as the always-on Greenhouse
# apply worker. Run once with sudo:  sudo bash linux-setup.sh /path/to/worker
#
# It does two things:
#   1. Makes the laptop ignore the lid switch, so closing the lid does NOT sleep it.
#   2. Installs a systemd timer that runs the apply loop every few hours, so it
#      keeps working after every run without you touching it.
set -euo pipefail

WORKER_DIR="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
RUN_USER="${SUDO_USER:-$USER}"
INTERVAL="${INTERVAL:-3h}"   # how often to run; override: INTERVAL=1h sudo bash linux-setup.sh

echo "Worker dir : $WORKER_DIR"
echo "Run as user: $RUN_USER"
echo "Interval   : $INTERVAL"

# ── 1. Ignore the lid switch (closed lid must NOT suspend) ────────────────────
echo "==> configuring logind to ignore the lid switch"
install -d /etc/systemd/logind.conf.d
cat >/etc/systemd/logind.conf.d/99-jobwatch-nolid.conf <<'EOF'
[Login]
HandleLidSwitch=ignore
HandleLidSwitchExternalPower=ignore
HandleLidSwitchDocked=ignore
EOF
# also block the sleep targets outright so nothing else suspends it
systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target || true
systemctl restart systemd-logind || true

# ── 2. systemd service + timer for the apply loop ─────────────────────────────
echo "==> installing systemd service + timer"
cat >/etc/systemd/system/jobwatch-apply.service <<EOF
[Unit]
Description=JobWatch Greenhouse auto-apply run
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
WorkingDirectory=$WORKER_DIR
# reads profile + jobs from Firestore; needs GOOGLE_APPLICATION_CREDENTIALS set
EnvironmentFile=-$WORKER_DIR/.env
ExecStart=/usr/bin/node $WORKER_DIR/run-loop.mjs
EOF

cat >/etc/systemd/system/jobwatch-apply.timer <<EOF
[Unit]
Description=Run JobWatch auto-apply every $INTERVAL

[Timer]
OnBootSec=2min
OnUnitActiveSec=$INTERVAL
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now jobwatch-apply.timer
echo "==> done. status:"
systemctl status jobwatch-apply.timer --no-pager | sed -n '1,6p' || true
echo
echo "Next: put your Firebase service-account json on this box and set"
echo "  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json  in $WORKER_DIR/.env"
echo "Check runs with:  journalctl -u jobwatch-apply.service -f"
