import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedBrowserPoolRegistrationSigningBytes } from "@opensteer/control-plane-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { loadOrCreateManagedBrowserPoolKeys } from "./managed-pool-keys.js";
import {
  ManagedBrowserPoolTargetService,
  type ManagedBrowserPoolAccount,
  type ManagedBrowserPoolTarget,
  type ManagedBrowserPoolTargetRecord,
  type ManagedBrowserPoolTargetResponse,
} from "./managed-pool-target.js";

const directories: string[] = [];
const services: ManagedBrowserPoolTargetService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true });
});

const cloudComputerId = "cc_0192f4a1-1111-4000-8000-000000000001";
const target = (term: number): ManagedBrowserPoolTarget => ({
  kind: "managed-pool",
  agentUrl: "http://10.40.0.10:7310",
  slotId: "bps_0192f4a1-1111-4000-8000-000000000001" as ManagedBrowserPoolTarget["slotId"],
  term,
  agentKey: "A".repeat(43) + "=",
  hostKey: "B".repeat(43) + "=",
  relay: { host: "10.40.0.10", port: 7312, relayHostKey: "C".repeat(43) + "=" },
});

/** The record as the Home's database keeps it, in memory, with what each step saw. */
function memoryRecord() {
  let row: Awaited<ReturnType<ManagedBrowserPoolTargetRecord["read"]>>;
  const record: ManagedBrowserPoolTargetRecord = {
    read: async () => row,
    attempt: async (keys) => {
      row = {
        attemptKeys: keys,
        registeredKeys: row?.registeredKeys ?? null,
        status: row?.status ?? "unregistered",
        target: row?.target ?? null,
      };
    },
    answer: async ({ response, registered, attemptUnreceived }) => {
      const settle = registered !== undefined || attemptUnreceived === true;
      row = {
        attemptKeys: settle ? null : (row?.attemptKeys ?? null),
        registeredKeys: registered ?? row?.registeredKeys ?? null,
        status: response.status,
        target: (response.target as Record<string, unknown> | undefined) ?? null,
      };
    },
  };
  return { record, row: () => row };
}

async function fixture(account: ManagedBrowserPoolAccount, onTarget = vi.fn()) {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-target-"));
  directories.push(directory);
  const keys = await loadOrCreateManagedBrowserPoolKeys(directory);
  const hostKey = generateKeyPairSync("ed25519");
  const memory = memoryRecord();
  const service = new ManagedBrowserPoolTargetService({
    cloudComputerId,
    keys,
    hostKey: hostKey.privateKey,
    account,
    record: memory.record,
    onTarget,
    firstDelayMs: 40,
    maxDelayMs: 1_000,
  });
  services.push(service);
  return { service, memory, hostKey, onTarget };
}

it("writes the attempt before the registration leaves, signs it with the pinned host key, and reads the target", async () => {
  const calls: string[] = [];
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const account: ManagedBrowserPoolAccount = {
    register: async (request) => {
      calls.push("register");
      // Durable before it was sent.
      expect(f!.memory.row()?.attemptKeys).toEqual(request.document.keys);
      expect(
        verify(
          null,
          managedBrowserPoolRegistrationSigningBytes(request.document),
          f!.hostKey.publicKey,
          Buffer.from(request.signature, "base64url"),
        ),
      ).toBe(true);
      return { status: "ready", target: target(1) };
    },
    target: async () => {
      calls.push("target");
      return { status: "ready", target: target(1) };
    },
  };
  f = await fixture(account);
  f.service.start();
  await vi.waitFor(() => expect(f!.onTarget).toHaveBeenCalledWith(target(1)));
  expect(calls).toEqual(["register"]);
  expect(f.memory.row()).toMatchObject({ attemptKeys: null, status: "ready" });
});

it("reads what the account holds before registering again after an answer that did not come", async () => {
  const calls: string[] = [];
  let lost = true;
  const account: ManagedBrowserPoolAccount = {
    register: async () => {
      calls.push("register");
      if (lost) {
        lost = false;
        throw new Error("The answer did not come.");
      }
      return { status: "preparing" };
    },
    target: async () => {
      calls.push("target");
      return calls.filter((call) => call === "register").length > 1
        ? { status: "ready", target: target(1) }
        : { status: "preparing" };
    },
  };
  const f = await fixture(account);
  f.service.start();
  await vi.waitFor(() => expect(f.onTarget).toHaveBeenCalled(), { timeout: 5_000 });
  // Never two registrations without a read of the target between them.
  expect(calls.slice(0, 3)).toEqual(["register", "target", "register"]);
});

it("asks a not-ready target again later and later, then nothing while ready, until it is suspected", async () => {
  const asked: number[] = [];
  let answer: ManagedBrowserPoolTargetResponse = { status: "preparing" };
  const account: ManagedBrowserPoolAccount = {
    register: async () => ({ status: "preparing" }),
    target: async () => {
      asked.push(Date.now());
      return answer;
    },
  };
  const onTarget = vi.fn();
  const f = await fixture(account, onTarget);
  f.service.start();
  await vi.waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(3), { timeout: 5_000 });
  expect(asked[2]! - asked[1]!).toBeGreaterThan(asked[1]! - asked[0]!);
  answer = { status: "ready", target: target(1) };
  await vi.waitFor(() => expect(onTarget).toHaveBeenCalledTimes(1), { timeout: 5_000 });
  const settled = asked.length;
  // Ready and answering: the account is not asked; a suspicion asks it, and a new term is a new
  // target.
  answer = { status: "ready", target: target(2) };
  f.service.suspect();
  await vi.waitFor(() => expect(onTarget).toHaveBeenLastCalledWith(target(2)));
  expect(asked.length).toBe(settled + 1);
});
