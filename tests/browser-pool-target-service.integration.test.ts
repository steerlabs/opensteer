import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The Home's target service against its real record on PostgreSQL (V5: the database gives jsonb
// back with its keys reordered, which an in-memory record never does). The account here answers
// as scripted; tests/browser-pool-home-account.integration.test.ts runs the real one.
import { managedBrowserPoolRegistrationSigningBytes } from "../packages/control-plane-protocol/src/index.js";
import { afterEach, expect, it, vi } from "vitest";
import { loadOrCreateManagedBrowserPoolKeys } from "../apps/host/src/browser/managed-pool-keys.js";
import {
  databaseManagedBrowserPoolTargetRecord,
  ManagedBrowserPoolTargetService,
  type ManagedBrowserPoolAccount,
  type ManagedBrowserPoolTarget,
  type ManagedBrowserPoolTargetResponse,
} from "../apps/host/src/browser/managed-pool-target.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";

const directories: string[] = [];
const services: ManagedBrowserPoolTargetService[] = [];
const stores: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const close of stores.splice(0)) await close();
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

/** The Home's own record of its registration and target, in its own database. */
async function databaseRecord() {
  const store = await createStoreFixture();
  stores.push(() => store.close());
  const record = databaseManagedBrowserPoolTargetRecord(store.database, cloudComputerId);
  return { record, read: () => record.read() };
}

async function fixture(account: ManagedBrowserPoolAccount, onTarget = vi.fn(), now?: () => Date) {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-pool-target-"));
  directories.push(directory);
  const keys = await loadOrCreateManagedBrowserPoolKeys(directory);
  const hostKey = generateKeyPairSync("ed25519");
  const memory = await databaseRecord();
  const service = new ManagedBrowserPoolTargetService({
    cloudComputerId,
    keys,
    hostKey: hostKey.privateKey,
    account,
    record: memory.record,
    onTarget,
    firstDelayMs: 40,
    maxDelayMs: 1_000,
    ...(now ? { now } : {}),
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
      expect((await f!.memory.read())?.attemptKeys).toEqual(request.document.keys);
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
  expect(await f.memory.read()).toMatchObject({ attemptKeys: null, status: "ready" });
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

it("asks the account at once when a settled target's call goes unanswered, at most once per 10 s, and takes a new target as a suspicion does", async () => {
  let clock = Date.parse("2026-11-26T16:26:52Z");
  const asked: number[] = [];
  let answer: ManagedBrowserPoolTargetResponse = { status: "ready", target: target(2) };
  const account: ManagedBrowserPoolAccount = {
    register: async () => answer,
    target: async () => {
      asked.push(clock);
      return answer;
    },
  };
  const onTarget = vi.fn();
  const f = await fixture(account, onTarget, () => new Date(clock));
  f.service.start();
  await vi.waitFor(() => expect(onTarget).toHaveBeenCalledWith(target(2)));
  const settled = asked.length;
  // A call to the settled target went unanswered: the account is asked now, once. It names the
  // same target: nothing changes, and the Home stays settled on it.
  f.service.check();
  await vi.waitFor(() => expect(asked.length).toBe(settled + 1));
  // More unanswered calls inside the same 10 s ask nothing more.
  clock += 9_999;
  f.service.check();
  f.service.check();
  await f.memory.read();
  expect(asked.length).toBe(settled + 1);
  expect(onTarget).toHaveBeenCalledTimes(1);
  // The account cannot be reached for one: nothing changes, and the target in hand stays.
  answer = { status: "preparing" };
  clock += 1;
  f.service.check();
  await vi.waitFor(() => expect(asked.length).toBe(settled + 2));
  // The pool host was replaced: the next unanswered call, 10 s on, learns the new target (another
  // address, the term one higher) and delivers it as any read does.
  const replaced = {
    ...target(3),
    agentUrl: "http://10.40.0.11:7310",
    relay: { ...target(3).relay, host: "10.40.0.11" },
  };
  answer = { status: "ready", target: replaced };
  clock += 10_000;
  f.service.check();
  await vi.waitFor(() => expect(onTarget).toHaveBeenLastCalledWith(replaced));
  expect(asked.length).toBe(settled + 3);
  // Settled again: with no unanswered call, nothing is read.
  clock += 60_000;
  await f.memory.read();
  expect(asked.length).toBe(settled + 3);
});
