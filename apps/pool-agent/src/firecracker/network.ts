/**
 * One network namespace per slot. Inside it: the guest's TAP (`tap0`, 172.16.0.1/30 on the
 * host side, the guest at .2), and a veth to the host. The guest can reach exactly one thing,
 * its egress proxy on 172.16.0.1:3128, which runs on the host in that namespace and leaves
 * through the veth; the host filters that traffic again (no private, link-local, metadata or
 * IPv6 destination; nothing on the host itself). Every name and address is the same in each
 * namespace except the veth, so a guest's device state never names another slot.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "./exec.js";

export const guestAddress = "172.16.0.2";
export const proxyAddress = "172.16.0.1";
export const proxyPort = 3128;
export const bridgePort = 4312;
export const tapName = "tap0";
export const guestMac = "06:00:ac:10:00:02";

export interface NetworkConfig {
  /** Public resolvers the egress proxy may ask; DNS to anything else is dropped. */
  readonly resolvers: readonly string[];
  /** Host TCP ports a slot's egress proxy may reach on the host itself (a local upstream). */
  readonly hostUpstreamPorts: readonly number[];
  /** The one local user allowed to connect to a guest's bridge port (the transport relay). */
  readonly relayUid: number | null;
}

export function namespaceName(index: number): string {
  return `osp${index}`;
}

export function hostVeth(index: number): string {
  return `ospv${index}`;
}

/** The /30 of the slot's veth: the host side is .1, the namespace side .2. */
export function vethAddresses(index: number): { readonly host: string; readonly inside: string } {
  if (!Number.isInteger(index) || index < 0 || index >= 16_384)
    throw new Error("Slot index out of range.");
  const base = (10 << 24) + (200 << 16) + index * 4;
  const ip = (value: number) =>
    [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
  return { host: ip(base + 1), inside: ip(base + 2) };
}

/** The host's own table, shared by all slots. Applied whole at agent start. */
export async function applyHostTable(config: NetworkConfig): Promise<void> {
  const upstreams = config.hostUpstreamPorts.length
    ? `iifname "ospv*" tcp dport { ${config.hostUpstreamPorts.join(", ")} } accept`
    : "";
  const resolvers = config.resolvers.length ? `{ ${config.resolvers.join(", ")} }` : "";
  const relay =
    config.relayUid === null
      ? `ip daddr 10.200.0.0/16 tcp dport ${bridgePort} reject`
      : `ip daddr 10.200.0.0/16 tcp dport ${bridgePort} meta skuid != ${config.relayUid} reject`;
  const ruleset = `
table inet opensteer_pool
delete table inet opensteer_pool
table inet opensteer_pool {
  set blocked4 {
    type ipv4_addr; flags interval;
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16,
                 172.16.0.0/12, 192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3 }
  }
  chain input {
    type filter hook input priority -10; policy accept;
    iifname "ospv*" ct state established,related accept
    ${upstreams}
    iifname "ospv*" counter drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    iifname "ospv*" jump from_slot
    oifname "ospv*" ct state established,related accept
    oifname "ospv*" counter drop
  }
  chain from_slot {
    meta nfproto ipv6 counter drop
    ${resolvers ? `ip daddr ${resolvers} meta l4proto { tcp, udp } th dport 53 accept` : ""}
    ip daddr @blocked4 counter drop
    meta l4proto tcp accept
    counter drop
  }
  chain output {
    type filter hook output priority -10; policy accept;
    ${relay}
  }
  chain postrouting {
    type nat hook postrouting priority 100;
    ip saddr 10.200.0.0/16 oifname != "ospv*" masquerade
  }
}
`;
  await applyRuleset([], ruleset);
}

/** The slot's namespace, TAP, veth and filter; repairs a missing piece, keeps a live one. */
export async function prepareNamespace(
  index: number,
  tapOwner: number,
  config: NetworkConfig,
): Promise<void> {
  const ns = namespaceName(index);
  const veth = hostVeth(index);
  const { host, inside } = vethAddresses(index);
  const inNs = (args: string[], allow?: number[]) =>
    run("ip", ["netns", "exec", ns, ...args], allow ? { allow } : {});
  const namespaces = await run("ip", ["netns", "list"]);
  if (!namespaces.split("\n").some((line) => line.split(" ")[0] === ns))
    await run("ip", ["netns", "add", ns]);
  await inNs(["sysctl", "-q", "-w", "net.ipv6.conf.all.disable_ipv6=1"]);
  await inNs(["sysctl", "-q", "-w", "net.ipv6.conf.default.disable_ipv6=1"]);
  await inNs(["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"]);
  await inNs(["ip", "link", "set", "lo", "up"]);
  const links = await inNs(["ip", "-o", "link", "show"]);
  if (!new RegExp(` ${tapName}[:@]`, "u").test(links)) {
    await inNs(["ip", "tuntap", "add", "dev", tapName, "mode", "tap", "user", String(tapOwner)]);
    await inNs(["ip", "addr", "add", `${proxyAddress}/30`, "dev", tapName]);
  }
  await inNs(["ip", "link", "set", tapName, "up"]);
  if (!links.includes(" eth0@")) {
    await run("ip", ["link", "del", veth], { allow: [1] });
    await run("ip", ["link", "add", veth, "type", "veth", "peer", "name", "eth0", "netns", ns]);
    await run("ip", ["addr", "add", `${host}/30`, "dev", veth]);
    await inNs(["ip", "addr", "add", `${inside}/30`, "dev", "eth0"]);
  }
  await run("ip", ["link", "set", veth, "up"]);
  await inNs(["ip", "link", "set", "eth0", "up"]);
  await inNs(["ip", "route", "replace", "default", "via", host, "dev", "eth0"]);
  // The proxy resolves names with these resolvers, never the host's own stub.
  await mkdir(join("/etc/netns", ns), { recursive: true, mode: 0o755 });
  await writeFile(
    join("/etc/netns", ns, "resolv.conf"),
    config.resolvers.map((address) => `nameserver ${address}\n`).join("") || "\n",
    { mode: 0o644 },
  );
  // The filter is created once; a live slot's gate (open or closed) is left as it is.
  const tables = await inNs(["nft", "list", "tables"]);
  if (!tables.includes("table inet osp"))
    await applyRuleset(["ip", "netns", "exec", ns], namespaceTable());
}

function namespaceTable(): string {
  return `
table inet osp {
  set open { type ifname; }
  chain input {
    type filter hook input priority 0; policy drop;
    iif "lo" accept
    iifname "${tapName}" iifname != @open drop
    ct state established,related accept
    iifname "${tapName}" ip saddr ${guestAddress} ip daddr ${proxyAddress} tcp dport ${proxyPort} accept
    counter drop
  }
  chain forward {
    type filter hook forward priority 0; policy drop;
    oifname "${tapName}" oifname != @open drop
    iifname "${tapName}" iifname != @open drop
    ct state established,related accept
    iifname "eth0" oifname "${tapName}" ip daddr ${guestAddress} tcp dport ${bridgePort} ct state new accept
    counter drop
  }
  chain output {
    type filter hook output priority 0; policy accept;
    oifname "${tapName}" oifname != @open drop
  }
  chain prerouting {
    type nat hook prerouting priority -100;
    iifname "eth0" meta nfproto ipv4 tcp dport ${bridgePort} dnat ip to ${guestAddress}:${bridgePort}
  }
}
`;
}

export async function setGate(index: number, open: boolean): Promise<void> {
  const ns = namespaceName(index);
  const command = open ? `add element inet osp open { "${tapName}" }` : "flush set inet osp open";
  await run("ip", ["netns", "exec", ns, "nft", command]);
}

export async function removeNamespace(index: number): Promise<void> {
  const ns = namespaceName(index);
  await run("ip", ["link", "del", hostVeth(index)], { allow: [1] });
  await run("ip", ["netns", "del", ns], { allow: [1] });
}

/** nft reads a ruleset only from a regular file (not a pipe) on some releases. */
async function applyRuleset(prefix: readonly string[], ruleset: string): Promise<void> {
  await mkdir("/run/opensteer-pool", { recursive: true, mode: 0o700 });
  const file = `/run/opensteer-pool/ruleset-${randomUUID()}.nft`;
  await writeFile(file, ruleset, { mode: 0o600 });
  try {
    const [command = "nft", ...rest] = prefix.length ? [...prefix, "nft"] : ["nft"];
    await run(command, [...rest, "-f", file]);
  } finally {
    await rm(file, { force: true });
  }
}
