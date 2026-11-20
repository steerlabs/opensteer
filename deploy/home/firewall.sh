#!/usr/bin/env bash
set -euo pipefail
[[ $# == 1 && $1 =~ ^[1-9][0-9]*$ ]] || { echo 'Home firewall requires the namespace owner PID.' >&2; exit 1; }

apply() {
  local tool=$1 loopback=$2
  shift 2
  {
    printf '%s\n' '*filter' ':OPENSTEER-HOME - [0:0]' '-F OPENSTEER-HOME'
    printf '%s\n' "-A OPENSTEER-HOME -o lo -d $loopback -j RETURN"
    printf '%s\n' '-A OPENSTEER-HOME -m conntrack --ctstate ESTABLISHED,RELATED --ctdir REPLY -j RETURN'
    printf '%s\n' '-A OPENSTEER-HOME -p tcp -m multiport --dports 25,465,587 -j REJECT'
    for range in "$@"; do printf '%s\n' "-A OPENSTEER-HOME -d $range -j REJECT"; done
    if ! nsenter -t "$pid" -n "${tool%-restore}" -w -C OUTPUT -j OPENSTEER-HOME 2>/dev/null; then
      printf '%s\n' '-I OUTPUT 1 -j OPENSTEER-HOME'
    fi
    printf '%s\n' COMMIT
  } | nsenter -t "$pid" -n "$tool" -w --noflush
}
pid=$1
apply iptables-restore 127.0.0.0/8 \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
  172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4
apply ip6tables-restore ::1/128 \
  ::/128 ::1/128 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 fc00::/7 fe80::/10 ff00::/8
