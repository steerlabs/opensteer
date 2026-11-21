/**
 * The slot's egress proxy: our browser-egress, on the host, in the slot's namespace, as its
 * own unprivileged user in a transient systemd unit. It holds every outside connection, so a
 * parked guest holds none. Its output is discarded; on a diagnostics host (driver.egressLog) it
 * prints refusal counts by reason only, never a host name, address or path (round D, D5).
 *
 * Review G6(a): the listening socket is a socket unit in the slot's namespace that stays open for
 * the slot's whole life, and the proxy process is a separate service started on demand. A slot
 * saved to disk keeps no proxy process; at a wake the process is started in parallel with the
 * restore, and a connection that arrives before it is up waits in the socket's backlog.
 */
import { existsSync } from "node:fs";
import type { SlotEgress } from "../driver.js";
import { run } from "./exec.js";
import { namespaceName, proxyAddress, proxyPort } from "./network.js";

export interface EgressProgram {
  /** The Node.js executable on the host. */
  readonly node: string;
  /** browser-egress's entry, `dist/egress-main.js` in the egress image's `/app`. */
  readonly main: string;
  /** A diagnostics host: the proxy's refusal counts go to the journal. */
  readonly debug?: boolean;
  /** One proxy's memory ceiling, in MiB (round D, D1: sized inside the host's guest budget). */
  readonly memoryMib?: number;
  /** One proxy's connection ceiling: sized from what one Chromium opens (round D, D1). */
  readonly maxConnections?: number;
}

/** Every slot proxy runs in this slice: one aggregate memory ceiling, made by setup-host.sh. */
export const egressSlice = "opensteer-pool-egress.slice";

export function egressUnit(index: number): string {
  return `opensteer-pool-egress-${index}.service`;
}

export function egressSocket(index: number): string {
  return `opensteer-pool-egress-${index}.socket`;
}

/** systemd runs a unit only as a user it can resolve: each slot's proxy has its own. */
export async function ensureEgressUser(index: number, uid: number): Promise<void> {
  const group = await run("getent", ["group", String(uid)], { allow: [2] });
  if (!group.trim())
    await run("groupadd", ["--system", "--gid", String(uid), `osp-egress-${index}`]);
  const known = await run("getent", ["passwd", String(uid)], { allow: [2] });
  if (known.trim()) return;
  await run("useradd", [
    "--system",
    "--no-create-home",
    "--home-dir",
    "/nonexistent",
    "--shell",
    "/usr/sbin/nologin",
    "--uid",
    String(uid),
    "--gid",
    String(uid),
    `osp-egress-${index}`,
  ]);
}

/** Whether the slot's listening socket exists (it is made once per slot, kept across parks). */
export async function egressDefined(index: number): Promise<boolean> {
  const state = await run("systemctl", ["is-active", egressSocket(index)], { allow: [3, 4] });
  return state.trim() === "active";
}

/** Makes the slot's socket and its (not yet started) proxy service. Idempotent. */
export async function defineEgress(
  program: EgressProgram,
  index: number,
  uid: number,
  upstream: SlotEgress | undefined,
): Promise<void> {
  if (await egressDefined(index)) return;
  const unit = egressUnit(index);
  await run("systemctl", ["stop", egressSocket(index), unit], { allow: [1, 5] });
  await run("systemctl", ["reset-failed", egressSocket(index), unit], { allow: [1, 5] });
  const credentials = upstream
    ? [
        `--property=LoadCredential=username:${upstream.usernameFile}`,
        `--property=LoadCredential=password:${upstream.passwordFile}`,
        ...(upstream.caFile ? [`--property=LoadCredential=ca:${upstream.caFile}`] : []),
        `--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL=${upstream.upstreamUrl}`,
        `--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_USERNAME_FILE=/run/credentials/${unit}/username`,
        `--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_PASSWORD_FILE=/run/credentials/${unit}/password`,
        ...(upstream.caFile
          ? [`--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_CA_FILE=/run/credentials/${unit}/ca`]
          : []),
        "--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true",
      ]
    : [];
  await run("systemd-run", [
    `--unit=${unit}`,
    "--quiet",
    `--socket-property=ListenStream=${proxyAddress}:${proxyPort}`,
    `--socket-property=NetworkNamespacePath=/run/netns/${namespaceName(index)}`,
    "--socket-property=FreeBind=yes",
    "--socket-property=Backlog=256",
    // Round D, D1: systemd's crash protection stays on. The agent's own stops reset the start
    // counter (sleepEgress), so only the proxy's own failures count: five starts in 30 s, with
    // a restart delay that backs off to 30 s, and then the proxy stays down until the slot's
    // next start or wake (reviveEgress), and the slot's status says so.
    `--slice=${egressSlice}`,
    "--property=StartLimitIntervalSec=30",
    "--property=StartLimitBurst=5",
    "--property=RestartSteps=5",
    "--property=RestartMaxDelaySec=30",
    // Equal weight between the slots' proxies, and a ceiling of one core each.
    "--property=CPUWeight=100",
    "--property=CPUQuota=100%",
    "--property=IOWeight=100",
    `--uid=${uid}`,
    `--gid=${uid}`,
    `--property=NetworkNamespacePath=/run/netns/${namespaceName(index)}`,
    // The host's resolver stub is on the host's loopback, not the namespace's: the proxy
    // resolves with the slot's own resolv.conf (and a slot hosts file, when one is given).
    `--property=BindReadOnlyPaths=/etc/netns/${namespaceName(index)}/resolv.conf:/etc/resolv.conf`,
    ...(existsSync(`/etc/netns/${namespaceName(index)}/hosts`)
      ? [`--property=BindReadOnlyPaths=/etc/netns/${namespaceName(index)}/hosts:/etc/hosts`]
      : []),
    "--property=Restart=on-failure",
    "--property=RestartSec=1",
    "--property=NoNewPrivileges=yes",
    "--property=CapabilityBoundingSet=",
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=yes",
    "--property=PrivateTmp=yes",
    "--property=PrivateDevices=yes",
    "--property=ProtectKernelTunables=yes",
    "--property=ProtectKernelModules=yes",
    "--property=ProtectControlGroups=yes",
    "--property=RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK",
    `--property=MemoryMax=${program.memoryMib ?? 80}M`,
    "--property=TasksMax=32",
    `--setenv=OPENSTEER_BROWSER_EGRESS_MAX_CONNECTIONS=${program.maxConnections ?? 128}`,
    "--property=LimitCORE=0",
    "--property=StandardOutput=null",
    // A diagnostics host (driver.egressLog) keeps the proxy's refusals in the journal.
    `--property=StandardError=${program.debug ? "journal" : "null"}`,
    ...(program.debug ? ["--setenv=OPENSTEER_BROWSER_EGRESS_DEBUG=1"] : []),
    `--setenv=OPENSTEER_BROWSER_EGRESS_HOST=${proxyAddress}`,
    `--setenv=OPENSTEER_BROWSER_EGRESS_PORT=${proxyPort}`,
    "--setenv=NODE_ENV=production",
    ...credentials,
    program.node,
    program.main,
  ]);
}

/**
 * Ends the proxy process; the socket stays, so the slot keeps its address. An agent's own stop
 * never counts against the proxy's start limit (round D, D1): the counter is reset with it.
 */
export async function sleepEgress(index: number): Promise<void> {
  await run("systemctl", ["stop", egressUnit(index)], { allow: [5] });
  await run("systemctl", ["reset-failed", egressUnit(index), egressSocket(index)], {
    allow: [1, 5],
  });
}

/**
 * At a slot's start or wake: a proxy that tripped its start limit (and took its socket down)
 * gets its socket back. True if it was down.
 */
export async function reviveEgress(index: number): Promise<boolean> {
  const failed = await run("systemctl", ["is-failed", egressSocket(index), egressUnit(index)], {
    allow: [1, 3, 4],
  });
  if (!failed.split("\n").some((line) => line.trim() === "failed")) return false;
  await run("systemctl", ["reset-failed", egressUnit(index), egressSocket(index)], {
    allow: [1, 5],
  });
  await run("systemctl", ["start", egressSocket(index)]);
  return true;
}

/** The slot numbers whose proxy (or its socket) failed: down until their next start or wake. */
export async function failedEgress(): Promise<readonly number[]> {
  const text = await run(
    "systemctl",
    ["list-units", "opensteer-pool-egress-*", "--state=failed", "--plain", "--no-legend"],
    { allow: [1] },
  );
  const indices = new Set<number>();
  for (const match of text.matchAll(/opensteer-pool-egress-(\d+)\.(?:service|socket)/gu))
    indices.add(Number(match[1]));
  return [...indices];
}

/** Ends the socket and the process: the slot is going away. */
export async function removeEgress(index: number): Promise<void> {
  await run("systemctl", ["stop", egressSocket(index), egressUnit(index)], { allow: [5] });
}
