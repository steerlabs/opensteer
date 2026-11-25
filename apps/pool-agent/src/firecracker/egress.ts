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
import { setTimeout as sleep } from "node:timers/promises";
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
  /**
   * Round H, on a host that pulls its slots' credentials: every proxy requires an upstream,
   * with credentials or without (then it refuses everything; it never connects directly), and
   * trusts the system's roots for it.
   */
  readonly upstreamRequired?: boolean;
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

/**
 * Makes the slot's socket and its (not yet started) proxy service. Idempotent: true if it
 * defined them now, false if they were already there (and are left as they are).
 */
export async function defineEgress(
  program: EgressProgram,
  index: number,
  uid: number,
  upstream: SlotEgress | undefined,
): Promise<boolean> {
  if (await egressDefined(index)) return false;
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
      ]
    : [];
  const required = upstream !== undefined || program.upstreamRequired === true;
  await run("systemd-run", [
    `--unit=${unit}`,
    "--quiet",
    `--socket-property=ListenStream=${proxyAddress}:${proxyPort}`,
    `--socket-property=NetworkNamespacePath=/run/netns/${namespaceName(index)}`,
    "--socket-property=FreeBind=yes",
    "--socket-property=Backlog=256",
    // Round D, D1: systemd's crash protection stays on. The agent's own stops reset the start
    // counter (sleepEgress), so only the proxy's own failures count: five starts in 120 s, with
    // a restart delay that backs off from 1 s to 30 s (five restarts then take about 22 s, so a
    // proxy that keeps crashing trips the limit; measured on run 5's host, a 30 s window never
    // tripped with that backoff). Status reports the failure, and the next start or wake can
    // recreate the socket or reset the service.
    `--slice=${egressSlice}`,
    "--property=StartLimitIntervalSec=120",
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
    `--property=MemoryMax=${program.memoryMib ?? 128}M`,
    "--property=TasksMax=32",
    `--setenv=OPENSTEER_BROWSER_EGRESS_MAX_CONNECTIONS=${program.maxConnections ?? 64}`,
    "--property=LimitCORE=0",
    "--property=StandardOutput=null",
    // A diagnostics host (driver.egressLog) keeps the proxy's refusals in the journal.
    `--property=StandardError=${program.debug ? "journal" : "null"}`,
    ...(program.debug ? ["--setenv=OPENSTEER_BROWSER_EGRESS_DEBUG=1"] : []),
    `--setenv=OPENSTEER_BROWSER_EGRESS_HOST=${proxyAddress}`,
    `--setenv=OPENSTEER_BROWSER_EGRESS_PORT=${proxyPort}`,
    "--setenv=NODE_ENV=production",
    ...credentials,
    ...(required ? ["--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true"] : []),
    program.node,
    ...(program.upstreamRequired ? ["--use-system-ca"] : []),
    program.main,
  ]);
  return true;
}

/**
 * Round H: what a slot's proxy unit was defined with, as systemd holds it: its upstream (or
 * none) and whether it requires one. Undefined when the unit is not loaded.
 */
export async function egressDefinition(index: number): Promise<
  | {
      readonly upstream: string | null;
      readonly required: boolean;
      /** Round I, U3: where it loads its credentials from (systemd's LoadCredential). */
      readonly credentials: { readonly username?: string; readonly password?: string };
    }
  | undefined
> {
  const loaded = await run("systemctl", ["show", "-p", "LoadState", "--value", egressUnit(index)], {
    allow: [1],
  });
  if (loaded.trim() !== "loaded") return undefined;
  const environment = await run(
    "systemctl",
    ["show", "-p", "Environment", "--value", egressUnit(index)],
    { allow: [1] },
  );
  const loads = await run(
    "systemctl",
    ["show", "-p", "LoadCredential", "--value", egressUnit(index)],
    { allow: [1] },
  );
  const entries = environment.trim().split(/\s+/u);
  const upstream = entries
    .find((entry) => entry.startsWith("OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL="))
    ?.slice("OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL=".length);
  const credentials: { username?: string; password?: string } = {};
  for (const entry of loads.trim().split(/\s+/u)) {
    const [name, ...source] = entry.split(":");
    if (name === "username" || name === "password") credentials[name] = source.join(":");
  }
  return {
    upstream: upstream ?? null,
    required: entries.includes("OPENSTEER_BROWSER_EGRESS_UPSTREAM_REQUIRED=true"),
    credentials,
  };
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
 * At a slot's start or wake: a proxy that tripped its start limit took its socket down with it,
 * and once that failure is reset (the agent's own stop of the slot does) systemd unloads the
 * transient socket. Whichever it is, a socket that is not listening is defined again. True if
 * it was down. Found on run 5's host: bringing back only a socket still marked failed left a
 * slot that had been stopped in between with no proxy.
 */
export async function reviveEgress(
  program: EgressProgram,
  index: number,
  uid: number,
  upstream: SlotEgress | undefined,
): Promise<boolean> {
  if (await egressDefined(index)) return false;
  await defineEgress(program, index, uid, upstream);
  return true;
}

/** The slot numbers whose proxy service or socket is currently failed. */
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

/** Clears a failed service or restart backoff so socket activation gets a fresh start. */
export async function resetEgressIfNeeded(index: number, signal: AbortSignal): Promise<void> {
  const state = (
    await run("systemctl", ["show", "-p", "ActiveState", "--value", egressUnit(index)], {
      allow: [1],
      signal,
    }).catch(() => "")
  ).trim();
  if (state === "activating" || state === "failed") await sleepEgress(index).catch(() => undefined);
}

/** Ends the socket and the process: the slot is going away. */
export async function removeEgress(index: number): Promise<void> {
  await run("systemctl", ["stop", egressSocket(index), egressUnit(index)], { allow: [5] });
}

/**
 * Confirms the slot's egress proxy process is running and serving `/health` inside its
 * network namespace (triggering socket activation if idle), within `signal`'s bound. Returns
 * `false` immediately if the proxy service or socket has entered `failed`, or if `signal` aborts
 * before a healthy `{"ok":true}` answer is received. A recheck makes one health request.
 */
export async function confirmEgress(
  index: number,
  signal: AbortSignal,
  once = false,
): Promise<boolean> {
  const unit = egressUnit(index);
  const healthUrl = `http://${proxyAddress}:${proxyPort}/health`;
  while (!signal.aborted) {
    const body = await run(
      "ip",
      [
        "netns",
        "exec",
        namespaceName(index),
        "curl",
        "-fsS",
        "--noproxy",
        "*",
        "--max-time",
        "2",
        healthUrl,
      ],
      { timeoutMs: 2_500, signal },
    ).catch(() => "");
    if (body) {
      try {
        const parsed = JSON.parse(body) as { ok?: unknown };
        if (parsed.ok === true) {
          const active = (
            await run("systemctl", ["is-active", unit], { allow: [3, 4], signal }).catch(() => "")
          ).trim();
          if (active === "active") return true;
        }
      } catch {
        // Non-JSON answer: keep checking until the bound expires or the unit fails.
      }
    }
    if (once || signal.aborted) return false;
    const states = await run(
      "systemctl",
      ["show", "-p", "ActiveState", "--value", unit, egressSocket(index)],
      { allow: [1], signal },
    ).catch(() => "");
    if (states.split(/\s+/u).includes("failed")) return false;
    try {
      await sleep(150, undefined, { signal });
    } catch {
      return false;
    }
  }
  return false;
}
