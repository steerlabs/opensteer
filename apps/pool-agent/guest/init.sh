#!/bin/sh
# PID 1 of a pool guest. The guest's address, its only route (the slot's egress proxy on the
# host side of its TAP) and its identity parameters come from the agent; nothing here is
# secret. The helper starts first: the agent waits for it before a start is reported done.
set -eu

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
b=/opensteer/busybox
profile=/var/lib/opensteer/browser

mount -t proc proc /proc
mount -t sysfs sys /sys
grep -q " /dev devtmpfs " /proc/mounts || mount -t devtmpfs devtmpfs /dev
mkdir -p /dev/shm
mount -t tmpfs -o size=512m,mode=1777 tmpfs /dev/shm
mount -t tmpfs tmpfs /run
mount -t tmpfs -o mode=1777 tmpfs /tmp
# The agent writes the bridge token here over vsock, once the helper answers.
mkdir -m 0711 /run/secrets
/opensteer/helper &

cmdline=$(cat /proc/cmdline)
param() {
    for word in $cmdline; do
        case "$word" in "$1="*) printf '%s\n' "${word#*=}"; return 0 ;; esac
    done
    return 1
}
mode=$(param opensteer.mode || echo runtime)

mount -o noatime /dev/vdb "$profile"
mkdir -p /tmp/home
chown 10001:10001 "$profile" /tmp/home
chmod 0700 "$profile" /tmp/home

"$b" ip link set lo up
"$b" ip addr add 172.16.0.2/30 dev eth0
"$b" ip link set eth0 up
"$b" ip route add default via 172.16.0.1
# No resolver: the root is read-only and ships an empty resolv.conf; names go to the proxy.

export HOME=/tmp/home
export OPENSTEER_BROWSER_PROXY_URL=http://172.16.0.1:3128
# The pool fence comes from the agent, outside the guest: the controller's public key, the
# slot, and the sequence floor below which no control may apply (an old one replayed).
OPENSTEER_BROWSER_POOL_SLOT=$(param opensteer.pool.slot || true)
OPENSTEER_BROWSER_POOL_CONTROLLER_KEY=$(param opensteer.pool.key || true)
OPENSTEER_BROWSER_POOL_FLOOR=$(param opensteer.pool.floor || true)
OPENSTEER_BROWSER_POOL_TICKET_KEY=$(param opensteer.pool.ticket || true)
OPENSTEER_BROWSER_POOL_PROXY=$(param opensteer.pool.proxy || true)
export OPENSTEER_BROWSER_POOL_SLOT OPENSTEER_BROWSER_POOL_CONTROLLER_KEY OPENSTEER_BROWSER_POOL_FLOOR
export OPENSTEER_BROWSER_POOL_TICKET_KEY OPENSTEER_BROWSER_POOL_PROXY

cd /app
if [ "$mode" = bench ]; then
    # The measurement's workload: Chromium with CDP, the fixture pages and a status endpoint,
    # reachable only from the slot's own network namespace on the host.
    install -d -m 0700 -o 10001 -g 10001 "$profile/chromium"
    node /opensteer/fixture.mjs &
    chromium=$(cat /opensteer/chromium-path)
    setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs \
        "$chromium" --user-data-dir="$profile/chromium" --remote-debugging-port=9222 \
        --disable-extensions --disable-component-extensions-with-background-pages \
        --disable-component-update --disable-background-networking --no-startup-window \
        --restore-last-session --no-first-run --no-default-browser-check --enable-automation \
        --disable-blink-features=WebAuth --headless=new --proxy-server="$OPENSTEER_BROWSER_PROXY_URL" \
        --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp \
        --proxy-bypass-list=127.0.0.1 &
else
    export OPENSTEER_MODE=production OPENSTEER_BROWSER_RUNTIME_ID=browser-main
    export OPENSTEER_BROWSER_HOST=0.0.0.0 OPENSTEER_BROWSER_PORT=4312
    export OPENSTEER_BROWSER_PROFILE_ROOT="$profile/runtime"
    export OPENSTEER_CHROMIUM_SANDBOX=true
    install -d -m 0700 -o 10001 -g 10001 "$OPENSTEER_BROWSER_PROFILE_ROOT"
    umask 077
    # The token comes from the agent over vsock, never from the guest or its command line.
    while [ ! -s /run/secrets/browser_token ]; do "$b" sleep 0.05; done
    export OPENSTEER_BROWSER_BRIDGE_TOKEN_FILE=/run/secrets/browser_token
    setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs \
        node /usr/local/bin/opensteer-entrypoint.mjs node dist/main.js &
fi

# PID 1 must stay alive and reap exited children.
while :; do wait || true; "$b" sleep 1; done
