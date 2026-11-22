/**
 * Round E, E2 (pool-agent-round-d-recheck-gemini.md, finding 2), through the real driver with
 * the host's tools replaced: a proxy revive that outlives its step must not leave a socket for a
 * deleted slot, nor redefine a new slot's proxy on a reused number with the old slot's upstream.
 * Written against 04f6c56b0, where it failed: the delete freed the number at once, the new slot
 * took it, and the late `systemd-run` then defined that number's proxy with the old upstream.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SlotEgress } from "../driver.js";
import { currentStepSignal } from "../step-signal.js";

/** What systemd holds: each number's listening socket and the upstream it was defined with. */
const sockets = new Map<number, string>();
let held: { readonly until: Promise<void> } | undefined;

vi.mock("./exec.js", () => ({
  run: async (command: string, args: readonly string[]) => {
    // As the real one: a step that was given up on starts no further tool.
    if (currentStepSignal()?.aborted) throw new Error(`${command} was not started: aborted.`);
    const index = (name: string | undefined) =>
      Number(/opensteer-pool-egress-(\d+)\./u.exec(name ?? "")?.[1]);
    if (command === "getent") return "exists\n";
    if (command === "systemctl" && args[0] === "is-active")
      return sockets.has(index(args[1])) ? "active\n" : "inactive\n";
    if (command === "systemctl" && args[0] === "stop") {
      for (const name of args.slice(1)) if (name.endsWith(".socket")) sockets.delete(index(name));
      return "";
    }
    if (command === "systemd-run") {
      const gate = held;
      held = undefined;
      // A request systemd already received is carried out, whatever happens to its caller.
      if (gate) await gate.until;
      const unit = args.find((arg) => arg.startsWith("--unit="));
      const upstream = args.find((arg) =>
        arg.startsWith("--setenv=OPENSTEER_BROWSER_EGRESS_UPSTREAM_URL="),
      );
      sockets.set(index(unit), upstream?.split("=").at(-1) ?? "none");
      return "";
    }
    return "";
  },
  runUntil: async () => undefined,
}));

vi.mock("./network.js", async (original) => ({
  ...(await original<typeof import("./network.js")>()),
  prepareNamespace: async () => undefined,
  namespaceTablesPresent: async () => true,
  removeNamespace: async () => undefined,
}));

const { FirecrackerDriver } = await import("./driver.js");

const egress = (upstream: string): SlotEgress => ({
  upstreamUrl: upstream,
  usernameFile: "/creds/user",
  passwordFile: "/creds/pass",
});

async function driver() {
  const created = new FirecrackerDriver({
    firecracker: "/fc",
    jailer: "/jailer",
    images: "/images",
    jailRoot: "/jail",
    savedRoot: "/saved",
    stateDirectory: await mkdtemp(join(tmpdir(), "opensteer-pool-numbers-")),
    arrayIdFile: "/array-id",
    profilesRoot: "/profiles",
    credentialsRoot: "/creds",
    slotUidBase: 200_000,
    egressUidBase: 300_000,
    egress: { node: "/node", main: "/main.js" },
    network: { resolvers: [], hostUpstreams: [] } as never,
    guestMode: "runtime",
  });
  await created.openSlotNumbers();
  return created;
}

/** The old slot's proxy tripped, and its revive at the next start is slow at `systemd-run`. */
async function slowRevive() {
  const d = await driver();
  await d.prepareSlot("old", egress("https://old.example:1"));
  expect(sockets.get(0)).toBe("https://old.example:1");
  sockets.delete(0);
  let release!: () => void;
  held = { until: new Promise<void>((resolve) => (release = resolve)) };
  const step = new AbortController();
  const reviving = d.reviveProxy("old", egress("https://old.example:1"), step.signal);
  await expect.poll(() => held).toBeUndefined();
  // The step ran out of time and was given up on.
  step.abort();
  return { d, reviving, release };
}

beforeEach(() => {
  sockets.clear();
  held = undefined;
});

describe("E2: work for a slot's number outlives its step", () => {
  it("leaves no socket for a slot deleted while its revive still ran", async () => {
    const { d, reviving, release } = await slowRevive();
    const deleting = d.removeSlot("old");
    release();
    await Promise.all([reviving, deleting]);
    expect(sockets.has(0)).toBe(false);
  });

  it("never gives a new slot on the reused number the old slot's proxy settings", async () => {
    const { d, reviving, release } = await slowRevive();
    const deleting = d.removeSlot("old");
    const creating = d.prepareSlot("new", egress("https://new.example:2"));
    release();
    await Promise.all([reviving, deleting, creating]);
    // The old number was held while its revive ran: the new slot has its own, and only its own
    // settings exist on the host.
    expect([...sockets.values()]).toEqual(["https://new.example:2"]);
    // Once that work ended the number is free, and the next slot on it gets its own settings.
    await d.prepareSlot("later", egress("https://later.example:3"));
    expect(sockets.get(0)).toBe("https://later.example:3");
  });
});
