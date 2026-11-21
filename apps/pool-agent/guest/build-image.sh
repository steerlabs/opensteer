#!/usr/bin/env bash
# Builds the pool guest image from our unmodified browser runtime image, as the measurement's
# build-rootfs.sh did (experiments/browser-pool on browser-pool-gcp, a74266859): the image's
# file tree as a read-only ext4 root, plus the guest init, the agent's helper and the
# measurement fixture. Writes rootfs.ext4, vmlinux, egress/ (the host-side egress proxy tree)
# and manifest.json with every file's SHA-256 into OUT. Run as root on a Linux build host.
set -euo pipefail

: "${RUNTIME_IMAGE:?the browser runtime image, such as local/opensteer-home-browser-runtime:tag}"
: "${EGRESS_IMAGE:?the browser egress image}"
: "${KERNEL:?a downloaded guest kernel (vmlinux) whose SHA-256 is KERNEL_SHA256}"
: "${KERNEL_SHA256:?}"
: "${OUT:?the output directory}"
here=$(cd -- "$(dirname -- "$0")" && pwd)

echo "$KERNEL_SHA256  $KERNEL" | sha256sum -c --quiet
install -d -m 0755 "$OUT"
test ! -e "$OUT/rootfs.ext4"
work=$(mktemp -d)
root="$work/root"
mkdir "$root"
cleanup() {
    for id in "${runtime:-}" "${egress:-}"; do
        if [[ -n "$id" ]]; then docker rm "$id" >/dev/null; fi
    done
    if mountpoint -q "$root"; then umount "$root"; fi
    rm -rf --one-file-system "$work"
}
trap cleanup EXIT

truncate -s 5G "$work/rootfs.ext4"
mkfs.ext4 -q -F -m 0 "$work/rootfs.ext4"
mount -o loop "$work/rootfs.ext4" "$root"
runtime=$(docker create "$RUNTIME_IMAGE")
egress=$(docker create "$EGRESS_IMAGE")
docker export "$runtime" | tar --numeric-owner -xpf - -C "$root"
# The egress image ships the same bundle; the host runs it outside the guest.
docker cp "$egress:/app" "$work/egress"
cmp "$work/egress/dist/egress-main.js" "$root/app/dist/egress-main.js"

install -d "$root/opensteer" "$root/dev/shm" "$root/run" "$root/tmp" "$root/var/lib/opensteer/browser"
install -m 0755 "$here/init.sh" "$root/opensteer/init"
install -m 0644 "$here/fixture.mjs" "$root/opensteer/fixture.mjs"
install -m 0755 "$(command -v busybox)" "$root/opensteer/busybox"
gcc -static -O2 -Wall -Werror -o "$root/opensteer/helper" "$here/helper.c"
chromium=$(find "$root/ms-playwright" -path '*/chromium-*/chrome-linux*/chrome' -type f | sort | head -1)
test -x "$chromium"
printf '%s\n' "${chromium#"$root"}" > "$root/opensteer/chromium-path"
rm -f "$root/etc/resolv.conf"
: > "$root/etc/resolv.conf"
printf '127.0.0.1 localhost\n' > "$root/etc/hosts"
sync
umount "$root"

mv "$work/rootfs.ext4" "$OUT/rootfs.ext4"
install -m 0444 "$KERNEL" "$OUT/vmlinux"
chmod 0444 "$OUT/rootfs.ext4"
rm -rf --one-file-system "$OUT/egress"
cp -a "$work/egress" "$OUT/egress"
chown -R root:root "$OUT/egress"
chmod -R go-w "$OUT/egress"
rootfs_sha=$(sha256sum "$OUT/rootfs.ext4" | cut -d' ' -f1)
egress_sha=$(sha256sum "$OUT/egress/dist/egress-main.js" | cut -d' ' -f1)
cat > "$OUT/manifest.json" <<EOF
{"kernelSha256":"$KERNEL_SHA256","rootfsSha256":"$rootfs_sha","egressSha256":"$egress_sha","runtimeImage":"$RUNTIME_IMAGE","egressImage":"$EGRESS_IMAGE","builtAt":"$(date -u +%FT%TZ)"}
EOF
chmod 0444 "$OUT/manifest.json"
echo "Built $OUT: rootfs $rootfs_sha"
