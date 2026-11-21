/**
 * The slot's egress proxy: our browser-egress, on the host, in the slot's namespace, as its
 * own unprivileged user in a transient systemd unit. It holds every outside connection, so a
 * parked guest holds none. Its output is discarded: what it would log is the person's browsing.
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
  /** A debug host: the proxy's refusals go to the journal. */
  readonly debug?: boolean;
}

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
    "--property=MemoryMax=256M",
    "--property=TasksMax=64",
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

/** Ends the proxy process; the socket stays, so the slot keeps its address. */
export async function sleepEgress(index: number): Promise<void> {
  await run("systemctl", ["stop", egressUnit(index)], { allow: [5] });
}

/** Ends the socket and the process: the slot is going away. */
export async function removeEgress(index: number): Promise<void> {
  await run("systemctl", ["stop", egressSocket(index), egressUnit(index)], { allow: [5] });
}
