#!/bin/sh
# TASK-INF-042 / FR-CALL-005 — certbot deploy hook (runs only after renewal).
set -eu
root=/opt/banana-chat
lineage=${RENEWED_LINEAGE:-/etc/letsencrypt/live/media.gamecoms.net}
# Ignore unrelated certificates when installed as a global deploy hook.
[ "$lineage" = /etc/letsencrypt/live/media.gamecoms.net ] || exit 0
openssl x509 -in "$lineage/fullchain.pem" -noout -checkend 86400 >/dev/null
install -d -m 700 "$root/infra/livekit/certs"
install -m 644 "$lineage/fullchain.pem" "$root/infra/livekit/certs/fullchain.pem"
install -m 600 "$lineage/privkey.pem" "$root/infra/livekit/certs/privkey.pem"
cd "$root"
# The directory mount makes replaced files visible. Restart loads the new pair.
if [ -n "$(docker compose --env-file infra/.env -f infra/docker-compose.prod.yml --profile calls ps -q livekit)" ]; then
    docker compose --env-file infra/.env -f infra/docker-compose.prod.yml --profile calls restart livekit
fi
