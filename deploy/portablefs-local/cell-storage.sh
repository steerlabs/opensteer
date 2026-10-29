#!/usr/bin/env bash
set -euo pipefail

image=/var/lib/portablefs-cell/cell.xfs
mountpoint=/srv/portablefs
loop_record=/run/portablefs-local-loop-device
image_size=${PORTABLEFS_CELL_IMAGE_SIZE:-8G}

case "${1:-}" in
  mount)
    install -d -o root -g root -m 0700 /var/lib/portablefs-cell
    install -d -o root -g root -m 0755 "$mountpoint"
    if [[ ! -e $image ]]; then
      temporary="${image}.creating"
      rm -f -- "$temporary"
      truncate -s "$image_size" "$temporary"
      mkfs.xfs -q -f "$temporary"
      mv -f -- "$temporary" "$image"
    fi
    [[ -f $image && ! -L $image ]] || {
      echo "portablefs-local-cell: XFS image is not a regular file" >&2
      exit 65
    }
    loop=$(losetup --find --show "$image")
    printf '%s\n' "$loop" >"$loop_record"
    mount -t xfs -o prjquota,nodev,nosuid,noexec,noatime "$loop" "$mountpoint"
    [[ $(findmnt -n -o FSTYPE -T "$mountpoint") == xfs ]]
    options=$(findmnt -n -o OPTIONS -T "$mountpoint")
    for required in prjquota nodev nosuid noexec noatime; do
      tr ',' '\n' <<<"$options" | grep -Fx "$required" >/dev/null
    done
    ;;
  unmount)
    if mountpoint -q "$mountpoint"; then
      umount "$mountpoint"
    fi
    if [[ -f $loop_record ]]; then
      loop=$(<"$loop_record")
      losetup --detach "$loop" 2>/dev/null || true
      rm -f -- "$loop_record"
    fi
    ;;
  *)
    echo "usage: portablefs-local-cell-storage mount|unmount" >&2
    exit 64
    ;;
esac
