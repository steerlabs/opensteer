#!/usr/bin/env bash
set -euo pipefail
[[ ( $# == 1 || ( $# -ge 2 && $# -le 3 && ( $2 == check || $2 == apply ) && ( ${3:-false} == true || ${3:-false} == false ) ) ) && $1 =~ ^[1-9][0-9]*$ ]] || { echo 'Home firewall requires the namespace owner PID.' >&2; exit 1; }

policy() {
  local tool=$1 loopback=$2
  shift 2
  {
    printf '%s\n' '*filter' ':OPENSTEER-HOME - [0:0]' '-F OPENSTEER-HOME'
    printf '%s\n' "-A OPENSTEER-HOME -d $loopback -o lo -j RETURN"
    printf '%s\n' '-A OPENSTEER-HOME -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN'
    printf '%s\n' '-A OPENSTEER-HOME -p tcp -m multiport --dports 25,465,587 -j REJECT'
    if [[ $tool == ip6tables-restore && $ipv6 == true ]]; then
      # Local IPv6 neighbor discovery is required to reply on published IPv6 ports.
      for type in 135 136; do
        printf '%s\n' "-A OPENSTEER-HOME -p ipv6-icmp -m icmp6 --icmpv6-type $type -j RETURN"
      done
    fi
    for range in "$@"; do
      if [[ $range == ::/0 ]]; then
        printf '%s\n' '-A OPENSTEER-HOME -j REJECT'
      else
        printf '%s\n' "-A OPENSTEER-HOME -d $range -j REJECT"
      fi
    done
  }
}
apply() {
  local tool=$1 expected installed first
  shift
  expected=$(policy "$tool-restore" "$@")
  if [[ $action == check ]]; then
    installed=$(nsenter -t "$pid" -n "$tool" -w -S OPENSTEER-HOME) || return
    [[ $(sed -n '/^-A /s/ --reject-with icmp6\{0,1\}-port-unreachable$//; /^-A /p' <<< "$installed") == "$(sed -n 's/^-A /-A /p' <<< "$expected")" ]] || return 1
    first=$(nsenter -t "$pid" -n "$tool" -w -S OUTPUT 1) || return
    [[ $first == '-A OUTPUT -j OPENSTEER-HOME' ]]
    return
  fi
  {
    printf '%s\n' "$expected"
    if nsenter -t "$pid" -n "$tool" -w -C OUTPUT -j OPENSTEER-HOME 2>/dev/null; then
      printf '%s\n' '-D OUTPUT -j OPENSTEER-HOME'
    fi
    printf '%s\n' '-I OUTPUT 1 -j OPENSTEER-HOME' COMMIT
  } | nsenter -t "$pid" -n "$tool-restore" -w --noflush
}
pid=$1
ipv6=${3:-false}
action=${2:-apply}
apply iptables 127.0.0.0/8 \
  0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
  172.16.0.0/12 192.168.0.0/16 198.18.0.0/15 224.0.0.0/4 240.0.0.0/4
if [[ $ipv6 == false ]]; then
  set -- ::/0
else
  set --
fi
apply ip6tables ::1/128   ::/128 ::1/128 ::ffff:0.0.0.0/96 64:ff9b::/96 64:ff9b:1::/48 fc00::/7 fe80::/10 ff00::/8 "$@"
