#!/usr/bin/env bash
set -euo pipefail
# A Cloud Computer's pool network: <private IPv4 CIDR> <agent port>,<relay port>, from its boot
# answer (or its account later, checked the same way). The only private destination the pod may
# reach, only on those two TCP ports, and only from the Host's own uid: the Runner, gateway and
# Channel Runtime share the Host's network namespace but not that uid, so an agent's shell
# cannot use it. Why that is narrow enough: Google's rule opensteer-pool-hosts-home lets machines
# tagged as Cloud Computers reach machines tagged as pool hosts on exactly these ports, and no
# Home listens on either, so the allow reaches pool hosts only (as long as nothing else in the
# subnet listens there: the account's and the provisioner's machines must not sit in it). The
# agent port answers only requests signed with the key the Home registered for its slot, and the
# relay only a TLS client holding the relay key registered for it.
pool_owner=10002 # The Host's uid on a Cloud Computer (compose.browser-pool.yaml).
valid_pool_network() {
  local cidr=$1 ports=$2 a b c d prefix address
  [[ $cidr =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})/([1-9]|[12][0-9]|3[0-2])$ ]] ||
    return 1
  a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]} prefix=${BASH_REMATCH[5]}
  ((a <= 255 && b <= 255 && c <= 255 && d <= 255)) || return 1
  address=$(((a << 24) | (b << 16) | (c << 8) | d))
  ((address % (1 << (32 - prefix)) == 0)) || return 1
  { ((a == 10 && prefix >= 8)) || ((a == 172 && b >= 16 && b <= 31 && prefix >= 12)) ||
    ((a == 192 && b == 168 && prefix >= 16)); } || return 1
  [[ $ports =~ ^([1-9][0-9]{0,4}),([1-9][0-9]{0,4})$ ]] || return 1
  local agent=${BASH_REMATCH[1]} relay=${BASH_REMATCH[2]}
  ((agent <= 65535 && relay <= 65535 && agent != relay)) || return 1
  # The mail ports are rejected before the allow: a pool there could never be reached.
  [[ " 25 465 587 " != *" $agent "* && " 25 465 587 " != *" $relay "* ]]
}

# firewall.sh validate-pool CIDR PORTS: only whether that pool network would be accepted.
if [[ ${1:-} == validate-pool ]]; then
  (($# == 3)) && valid_pool_network "$2" "$3"
  exit
fi

[[ ( $# == 1 || ( ( $# == 2 || $# == 3 || $# == 5 ) && ( $2 == check || $2 == apply ) && ( ${3:-false} == true || ${3:-false} == false ) ) ) && $1 =~ ^[1-9][0-9]*$ ]] || { echo 'Home firewall requires the namespace owner PID.' >&2; exit 1; }

pool_rule=''
if (($# == 5)); then
  valid_pool_network "$4" "$5" || { echo 'Home firewall refused an invalid pool network.' >&2; exit 1; }
  pool_rule="-A OPENSTEER-HOME -d $4 -p tcp -m owner --uid-owner $pool_owner -m multiport --dports $5 -j RETURN"
fi

policy() {
  local tool=$1 loopback=$2
  shift 2
  {
    printf '%s\n' '*filter' ':OPENSTEER-HOME - [0:0]' '-F OPENSTEER-HOME'
    printf '%s\n' "-A OPENSTEER-HOME -d $loopback -o lo -j RETURN"
    printf '%s\n' '-A OPENSTEER-HOME -m conntrack --ctstate RELATED,ESTABLISHED --ctdir REPLY -j RETURN'
    printf '%s\n' '-A OPENSTEER-HOME -p tcp -m multiport --dports 25,465,587 -j REJECT'
    if [[ $tool == iptables-restore && -n $pool_rule ]]; then printf '%s\n' "$pool_rule"; fi
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
