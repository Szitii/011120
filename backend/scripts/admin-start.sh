#!/bin/sh
# Starts the admin console on its server (Dockerfile.admin): join the tailnet, then serve the console
# to it. Tailscale keeps its identity on the volume at /var/lib/tailscale, so TS_AUTHKEY is used
# only on the very first start.
set -eu
: "${ADMIN_HOSTNAME:=companion-admin}"
export ADMIN_HOSTNAME

tailscaled --tun=userspace-networking --statedir=/var/lib/tailscale &
i=0
until tailscale up --hostname="$ADMIN_HOSTNAME" --advertise-tags=tag:admin-console ${TS_AUTHKEY:+--authkey="$TS_AUTHKEY"}; do
  i=$((i + 1)); [ "$i" -lt 30 ] || { echo "could not join the tailnet" >&2; exit 1; }
  sleep 1
done
tailscale serve --bg --http=80 http://127.0.0.1:8790

# The console itself runs as the unprivileged node user, on 127.0.0.1 only; it does not need the key.
unset TS_AUTHKEY
exec setpriv --reuid=node --regid=node --init-groups node --experimental-strip-types backend/scripts/admin-console.ts
