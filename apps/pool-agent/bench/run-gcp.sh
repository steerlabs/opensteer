#!/usr/bin/env bash
# The real-host run on a disposable Google Cloud host, as root, from the unpacked source tree:
#   run-gcp.sh deps     setup-host.sh install, plus Docker and the build tools for the image
#   run-gcp.sh images   the browser runtime and egress images, then guest/build-image.sh
#   run-gcp.sh agent    agent config (bench guests), upstream forwarder, profiles, the service
#   run-gcp.sh bench    the root helper, then the bench as the relay user
#   run-gcp.sh runtime  our runtime in the guests: guestMode runtime, the relay started
# The host has no external address: package downloads use http(s)_proxy (an IAP reverse tunnel
# to a temporary proxy, as the measurement did), and so does the egress upstream forwarder.
set -euo pipefail
src=$(cd -- "$(dirname -- "$0")/../../.." && pwd)
agent_dir="$src/apps/pool-agent"
proxy=${PROXY:-http://127.0.0.1:3128}
bench=/var/lib/opensteer-pool-bench
creds=/etc/opensteer-pool-bench

deps() {
    http_proxy=$proxy https_proxy=$proxy bash "$agent_dir/host/setup-host.sh" install || true
    export DEBIAN_FRONTEND=noninteractive
    http_proxy=$proxy https_proxy=$proxy apt-get install -y -q --no-install-recommends \
        docker.io docker-buildx busybox-static build-essential socat openssl e2fsprogs
    install -d /etc/systemd/system/docker.service.d
    printf '[Service]\nEnvironment=HTTP_PROXY=%s HTTPS_PROXY=%s NO_PROXY=localhost,127.0.0.1\n' "$proxy" "$proxy" \
        > /etc/systemd/system/docker.service.d/proxy.conf
    systemctl daemon-reload
    systemctl restart docker
}

images() {
    cd "$src"
    docker buildx inspect pool-build >/dev/null 2>&1 || docker buildx create --name pool-build \
        --driver docker-container --driver-opt network=host \
        --driver-opt env.http_proxy="$proxy" --driver-opt env.https_proxy="$proxy" \
        --buildkitd-flags=--allow-insecure-entitlement=network.host --bootstrap
    sed '/^FROM .* AS dependencies$/a ENV NODE_USE_ENV_PROXY=1' deploy/container/Containerfile \
        > deploy/container/Containerfile.pool
    env HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy" \
        NO_PROXY=localhost,127.0.0.1 REGISTRY=local TAG=pool RELEASE_VERSION=0.1.219 \
        SOURCE_REVISION="$(cat "$src/.source-revision")" CACHE_BACKEND=none CACHE_EXPORT=false \
        docker buildx bake --builder pool-build -f deploy/container/docker-bake.hcl \
        --set 'home-*.dockerfile=deploy/container/Containerfile.pool' \
        --set 'home-*.platform=linux/amd64' --set 'home-*.network=host' \
        --set "home-*.args.HTTP_PROXY=$proxy" --set "home-*.args.HTTPS_PROXY=$proxy" \
        --set "home-*.args.http_proxy=$proxy" --set "home-*.args.https_proxy=$proxy" \
        --allow network.host --load --progress=plain home-browser-runtime home-browser-egress
    rm -f /var/lib/opensteer-pool/images/rootfs.ext4 /var/lib/opensteer-pool/images/vmlinux \
        /var/lib/opensteer-pool/images/manifest.json
    RUNTIME_IMAGE=local/opensteer-home-browser-runtime:pool EGRESS_IMAGE=local/opensteer-home-browser-egress:pool \
        KERNEL=/var/lib/opensteer-pool/images/vmlinux.download \
        KERNEL_SHA256=c7f899cbd24b856bca2a6db1736a48f90b4fe1f75cd3f53e775f36d8e8b00a40 \
        OUT=/var/lib/opensteer-pool/images bash "$agent_dir/guest/build-image.sh"
    bash "$agent_dir/host/setup-host.sh" boot
}

agent() {
    install -d -m 0755 /opt/opensteer-pool/agent
    # The bench run installs the bench entry (the production daemon plus its crash hook, for the
    # restart-in-a-transition checks); setup-host.sh never installs it.
    install -m 0644 "$agent_dir/dist/bench-agent.mjs" /opt/opensteer-pool/agent/main.js
    install -m 0644 "$agent_dir/dist/relay.mjs" /opt/opensteer-pool/agent/relay.mjs
    install -d -m 0700 "$creds"
    install -d -m 0711 "$bench"
    local relay_uid; relay_uid=$(id -u opensteer-pool-relay)
    # The bench's provisioner key; the relay user reads it (test only).
    if [[ ! -f $creds/provisioner.pem ]]; then
        openssl genpkey -algorithm ed25519 -out "$creds/provisioner.pem"
    fi
    chown opensteer-pool-relay "$creds/provisioner.pem"; chmod 0400 "$creds/provisioner.pem"
    chmod 0711 "$creds"
    local spki; spki=$(openssl pkey -in "$creds/provisioner.pem" -pubout -outform DER | base64 -w0)
    cat > /etc/opensteer-pool/agent.json <<EOF
{
  "journal": "/var/lib/opensteer-pool/journal",
  "listen": { "host": "127.0.0.1", "port": 7310 },
  "admin": { "listen": { "host": "127.0.0.1", "port": 7311 }, "provisionerKey": "$spki", "hostId": "pool-bench-host", "hostKeyFile": "/etc/opensteer-pool/host-key.pem" },
  "retentionHours": 24,
  "saveAfterSeconds": 4,
  "maxConcurrentSaves": 2,
  "driver": {
    "firecracker": "/opt/opensteer-pool/bin/firecracker",
    "jailer": "/opt/opensteer-pool/bin/jailer",
    "images": "/srv/opensteer-pool/images",
    "jailRoot": "/srv/opensteer-pool/jail",
    "savedRoot": "/srv/opensteer-pool/saved",
    "stateDirectory": "/var/lib/opensteer-pool/driver",
    "arrayIdFile": "/srv/opensteer-pool/array-id",
    "profilesRoot": "/var/lib/opensteer-pool/profiles",
    "credentialsRoot": "/etc/opensteer-pool-bench",
    "slotUidBase": 200000,
    "egressUidBase": 300000,
    "egress": { "node": "/opt/opensteer-pool/node/bin/node", "main": "/var/lib/opensteer-pool/images/egress/dist/egress-main.js" },
    "network": { "resolvers": [], "privateResolvers": ["169.254.169.254"], "hostUpstreams": [{ "address": "192.0.43.10", "port": 8443 }], "relayUid": $relay_uid },
    "guestMode": "bench",
    "egressLog": true
  }
}
EOF
    chmod 0600 /etc/opensteer-pool/agent.json
    # The egress upstream for this host without an external address: a TLS forwarder to the
    # temporary proxy, on an address browser-egress counts as public (192.0.43.10, IANA-held,
    # on a dummy interface of this disposable host). The slots' proxies resolve example.com
    # from a slot hosts file, since the host has no DNS of its own to offer them.
    ip link show pool-up >/dev/null 2>&1 || ip link add pool-up type dummy
    ip addr replace 192.0.43.10/32 dev pool-up
    ip link set pool-up up
    if [[ ! -f $creds/upstream-ca.pem ]]; then
        openssl req -x509 -newkey ed25519 -nodes -days 2 -subj "/CN=pool-bench-upstream" \
            -addext "subjectAltName=IP:192.0.43.10" -keyout "$creds/upstream-key.pem" -out "$creds/upstream-ca.pem"
        printf 'bench\n' > "$creds/upstream-username"
        openssl rand -hex 16 > "$creds/upstream-password"
        chmod 0600 "$creds"/upstream-*
    fi
    # Names resolve through the host's private resolver (Google Cloud's, re-check finding 2);
    # a slot hosts file is written only when one is asked for.
    if [[ -n ${EXAMPLE_COM_ADDRESS:-} ]]; then
        for index in 0 1 2 3 4; do
            install -d -m 0755 "/etc/netns/osp$index"
            printf '%s example.com\n' "$EXAMPLE_COM_ADDRESS" > "/etc/netns/osp$index/hosts"
        done
    fi
    systemctl stop pool-bench-upstream.service 2>/dev/null || true
    systemd-run --unit=pool-bench-upstream.service --collect --property=Restart=always \
        socat "OPENSSL-LISTEN:8443,bind=192.0.43.10,fork,reuseaddr,cert=$creds/upstream-ca.pem,key=$creds/upstream-key.pem,verify=0" \
        "TCP:127.0.0.1:${proxy##*:}"
    install -d -m 0711 /var/lib/opensteer-pool/profiles
    for index in 0 1 2 3 4; do
        local profile=/var/lib/opensteer-pool/profiles/bench-$index.ext4
        if [[ ! -f $profile ]]; then truncate -s 1G "$profile"; mkfs.ext4 -q -F -m 0 "$profile"; fi
    done
    systemctl enable opensteer-pool-agent.service >/dev/null
    systemctl restart opensteer-pool-agent.service
}

run_bench() {
    systemctl stop pool-bench-helper.service 2>/dev/null || true
    systemd-run --unit=pool-bench-helper.service --collect \
        /opt/opensteer-pool/node/bin/node "$agent_dir/bench/root-helper.mjs" \
        /run/opensteer-pool-bench-helper.sock opensteer-pool-relay
    for _ in $(seq 50); do [[ -S /run/opensteer-pool-bench-helper.sock ]] && break; sleep 0.1; done
    # The agent answers only after it reconciled every slot.
    for _ in $(seq 150); do curl -s -o /dev/null http://127.0.0.1:7310/v1 && break; sleep 0.2; done
    install -d -o opensteer-pool-relay -m 0755 "$bench/out"
    # The host key's public half is what the provisioner pins; the bench reads a copy.
    install -m 0644 /etc/opensteer-pool/host-key.pub "$creds/host-key.pub"
    install -m 0644 /etc/opensteer-pool-relay/relay-key.pub "$creds/relay-key.pub"
    setpriv --reuid=opensteer-pool-relay --regid=opensteer-pool-relay --clear-groups --no-new-privs \
        /opt/opensteer-pool/node/bin/node "$agent_dir/dist/real-host.mjs" \
        --provisioner-key "$creds/provisioner.pem" --host-key "$creds/host-key.pub" --host-id pool-bench-host --helper /run/opensteer-pool-bench-helper.sock \
        --credentials "$creds" --out "$bench/out/results.jsonl" "$@"
}

runtime_mode() {
    # Our runtime in the guests (pool-runtime-in-guest.md): every slot started from here runs it.
    python3 - <<'PY'
import json
path = "/etc/opensteer-pool/agent.json"
config = json.load(open(path))
config["driver"]["guestMode"] = "runtime"
open(path, "w").write(json.dumps(config, indent=2))
PY
    chmod 0600 /etc/opensteer-pool/agent.json
    local profile=/var/lib/opensteer-pool/profiles/proof-0.ext4
    if [[ ! -f $profile ]]; then truncate -s 2G "$profile"; mkfs.ext4 -q -F -m 0 "$profile"; fi
    systemctl restart opensteer-pool-agent.service
    systemctl enable opensteer-pool-relay.service >/dev/null
    systemctl restart opensteer-pool-relay.service
}

case "${1:-}" in
    deps) deps ;;
    images) images ;;
    agent) agent ;;
    bench) shift; run_bench "$@" ;;
    runtime) runtime_mode ;;
    *) echo "usage: $0 deps|images|agent|bench|runtime" >&2; exit 2 ;;
esac
