/**
 * The slot's egress proxy: our browser-egress, on the host, in the slot's namespace, as its
 * own unprivileged user in a transient systemd unit. It holds every outside connection, so a
 * parked guest holds none. Its output is discarded: what it would log is the person's browsing.
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
}

export function egressUnit(index: number): string {
  return `opensteer-pool-egress-${index}.service`;
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

export async function egressActive(index: number): Promise<boolean> {
  const state = await run("systemctl", ["is-active", egressUnit(index)], { allow: [3, 4] });
  return state.trim() === "active";
}

export async function startEgress(
  program: EgressProgram,
  index: number,
  uid: number,
  upstream: SlotEgress | undefined,
): Promise<void> {
  if (await egressActive(index)) return;
  const unit = egressUnit(index);
  await run("systemctl", ["reset-failed", unit], { allow: [1, 5] });
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
    "--collect",
    `--uid=${uid}`,
    `--gid=${uid}`,
    `--property=NetworkNamespacePath=/run/netns/${namespaceName(index)}`,
    // The host's resolver stub is on the host's loopback, not the namespace's: the proxy
    // resolves with the slot's own resolv.conf (and a slot hosts file, when one is given).
    `--property=BindReadOnlyPaths=/etc/netns/${namespaceName(index)}/resolv.conf:/etc/resolv.conf`,
    ...(existsSync(`/etc/netns/${namespaceName(index)}/hosts`)
      ? [`--property=BindReadOnlyPaths=/etc/netns/${namespaceName(index)}/hosts:/etc/hosts`]
      : []),
    "--property=Restart=always",
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
    "--property=StandardError=null",
    `--setenv=OPENSTEER_BROWSER_EGRESS_HOST=${proxyAddress}`,
    `--setenv=OPENSTEER_BROWSER_EGRESS_PORT=${proxyPort}`,
    "--setenv=NODE_ENV=production",
    ...credentials,
    program.node,
    program.main,
  ]);
}

/** Resolves once the proxy listens inside the slot's namespace. */
export async function waitForEgress(index: number, signal: AbortSignal): Promise<void> {
  for (;;) {
    const listening = await run("ip", [
      "netns",
      "exec",
      namespaceName(index),
      "ss",
      "-Hltn",
      `sport = :${proxyPort}`,
    ]).catch(() => "");
    if (listening.trim()) return;
    if (signal.aborted) throw new Error("The slot's egress proxy did not start.");
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

export async function stopEgress(index: number): Promise<void> {
  await run("systemctl", ["stop", egressUnit(index)], { allow: [5] });
}
