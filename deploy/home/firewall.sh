#!/usr/bin/env bash
set -euo pipefail
[[ ( $# == 1 || ( ( $# == 2 || $# == 3 || $# == 5 ) && ( $2 == check || $2 == apply ) && ( ${3:-false} == true || ${3:-false} == false ) ) ) && $1 =~ ^[1-9][0-9]*$ ]] || { echo 'Home firewall requires the namespace owner PID.' >&2; exit 1; }

# A Cloud Computer's pool network: <private IPv4 CIDR> <agent port>,<relay port>, from its boot
# answer. The only private destination the pod may reach, and only on those two TCP ports. Why
# that is narrow enough: Google's own rule (opensteer-pool-hosts-home) lets only machines tagged
# as Cloud Computers reach machines tagged as pool hosts, on exactly these ports; other Homes in
# the subnet listen on neither, and Google's rules do not let Homes reach each other. The agent
# port answers only requests signed with the key the Home registered for its slot, and the relay
# only a TLS client holding the relay key registered for it. The Host, Runner, gateway and Channel
# Runtime share this one network namespace (and one uid), so this one rule serves them all.
pool_rule=''
if (($# == 5)); then
  pool_cidr=$4 pool_ports=$5
  valid_pool=false
  if [[ $pool_cidr =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})/([1-9]|[12][0-9]|3[0-2])$ ]]; then
    a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]} prefix=${BASH_REMATCH[5]}
    if ((a <= 255 && b <= 255 && c <= 255 && d <= 255)); then
      address=$(((a << 24) | (b << 16) | (c << 8) | d))
      if ((address % (1 << (32 - prefix)) == 0)) &&
        { ((a == 10 && prefix >= 8)) || ((a == 172 && b >= 16 && b <= 31 && prefix >= 12)) ||
          ((a == 192 && b == 168 && prefix >= 16)); }; then
        valid_pool=true
      fi
    fi
  fi
  if [[ $pool_ports =~ ^([1-9][0-9]{0,4}),([1-9][0-9]{0,4})$ ]] &&
    ((BASH_REMATCH[1] <= 65535 && BASH_REMATCH[2] <= 65535 && BASH_REMATCH[1] != BASH_REMATCH[2])); then
    :
  else
    valid_pool=false
  fi
  $valid_pool || { echo 'Home firewall refused an invalid pool network.' >&2; exit 1; }
  pool_rule="-A OPENSTEER-HOME -d $pool_cidr -p tcp -m multiport --dports $pool_ports -j RETURN"
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
