import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createId } from "@opensteer/core";
import { ControlPlaneAccountIdSchema } from "@opensteer/control-plane-protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import { type SavedHostView, type SavedViewScope } from "@opensteer/client/host";
import { afterEach, expect, it } from "vitest";
import { createSavedHostViewStore } from "./saved-host-view-store.js";
import { savedViewFixture, savedViewTestCrypto as crypto } from "../../test-support/saved-views.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const fixture = () => savedViewFixture(cleanup);
const scope = (): SavedViewScope => ({
  schema: 1,
  epoch: hostApiVersion,
  hostIdentity: {
    deploymentId: createId("deployment"),
    hostInstanceId: createId("hostInstance"),
    hostKeyFingerprint: `sha256:${"a".repeat(43)}`,
  },
  loginId: globalThis.crypto.randomUUID(),
});
const view = (s = scope()): SavedHostView => ({
  ...s,
  userId: createId("user"),
  capturedAt: new Date().toISOString(),
  tasks: [],
});
it("uses real AEAD, fresh nonces, one small key slot and rejects other scopes/tampering", async () => {
  const f = fixture(),
    store = f.open(),
    value = view();
  await store.write(value, () => true);
  expect(await store.load(value, () => true)).toEqual(value);
  const name = f.list()[0]!.name,
    path = `${f.directory}/${name}`;
  const first = readFileSync(path);
  await store.write(value, () => true);
  expect(readFileSync(path)).not.toEqual(first);
  expect(f.slots()).toHaveLength(1);
  for (const changed of [
    { epoch: value.epoch + 1 },
    { schema: 2 },
    { loginId: globalThis.crypto.randomUUID() },
    { hostIdentity: { ...value.hostIdentity, hostInstanceId: createId("hostInstance") } },
    {
      accountSource: {
        issuer: "https://account.test",
        subject: "acct_0192f4a1-3333-4000-8000-000000000003",
        loginId: globalThis.crypto.randomUUID(),
      },
    },
  ]) {
    expect(await store.load({ ...value, ...changed } as SavedViewScope, () => true)).toBeNull();
  }
  const corrupt = readFileSync(path);
  corrupt[40] = corrupt[40]! ^ 1;
  writeFileSync(path, corrupt);
  expect(await store.load(value, () => true)).toBeNull();
});
it("missing/locked keys miss, and deletion erases before failed ciphertext cleanup", async () => {
  const f = fixture(),
    value = view(),
    store = f.open();
  expect(await store.load(value, () => true)).toBeNull();
  expect(f.slots()).toEqual([]);
  await store.write(value, () => true);
  const get = f.keys.getItemAsync.bind(f.keys);
  f.keys.getItemAsync = async () => {
    throw new Error("locked");
  };
  expect(await store.load(value, () => true)).toBeNull();
  expect(f.slots()).toHaveLength(1);
  f.keys.getItemAsync = get;
  f.interrupt((step) => {
    if (step.startsWith("delete:")) throw new Error("disk failure");
  });
  await store.invalidate(value.hostIdentity.deploymentId);
  expect(f.slots()).toEqual([]);
  expect(await f.open().load(value, () => true)).toBeNull();
});
it("reports secure deletion failure and never commits a fenced encryption", async () => {
  const f = fixture(),
    value = view(),
    store = f.open();
  await store.write(value, () => true);
  f.keys.interrupt = (step) => {
    if (step.startsWith("delete:")) throw new Error("locked");
  };
  await expect(store.invalidate(value.hostIdentity.deploymentId)).rejects.toThrow("locked");
  f.keys.interrupt = () => {};
  await store.invalidate(value.hostIdentity.deploymentId);
  let current = true;
  const blocked = createSavedHostViewStore({
    files: f.files,
    directory: f.root.slice(0, -1),
    list: f.list,
    keys: f.keys,
    keyPrefix: "saved",
    crypto: {
      ...crypto,
      encrypt: async (...args) => {
        const result = await crypto.encrypt(...args);
        current = false;
        return result;
      },
    },
  });
  await blocked.write(value, () => current);
  expect(f.list()).toEqual([]);
});
it("settles every interrupted replacement journal on restart", async () => {
  for (const step of ["create:", "write:", "move:", "delete:"]) {
    const f = fixture(),
      value = view(),
      store = f.open();
    await store.write(value, () => true);
    let thrown = false;
    f.interrupt((s) => {
      if (!thrown && s.startsWith(step)) {
        thrown = true;
        throw new Error("terminated");
      }
    });
    await store
      .write({ ...value, capturedAt: "2026-10-29T01:00:00.000Z" }, () => true)
      .catch(() => {});
    f.interrupt(() => {});
    const loaded = await f.open().load(value, () => true);
    expect(loaded?.userId).toBe(value.userId);
    expect(
      f
        .list()
        .map(({ name }) => name)
        .filter((name) => /\.(new|old)$/u.test(name)),
    ).toEqual([]);
  }
});
it("bounds committed files to four, evicts oldest write, skips on cleanup failure", async () => {
  const f = fixture(),
    store = f.open(),
    values = Array.from({ length: 6 }, () => view());
  for (const value of values) await store.write(value, () => true);
  expect(f.list()).toHaveLength(4);
  expect(f.slots()).toHaveLength(4);
  expect(await store.load(values[0]!, () => true)).toBeNull();
  f.interrupt((s) => {
    if (s.startsWith("delete:")) throw new Error("disk full");
  });
  await expect(store.write(view(), () => true)).rejects.toThrow();
  expect(f.list()).toHaveLength(4);
  await expect(
    store.write(
      {
        ...values[5]!,
        tasks: [],
        home: {
          workspaceId: createId("workspace"),
          threadId: createId("thread"),
          messages: [{ voice: "agent", text: "a".repeat(1_048_576) }],
        },
      },
      () => true,
    ),
  ).rejects.toThrow();
});

it("bounds key slots after the OS purges the cache files that named them", async () => {
  const f = fixture(),
    store = f.open(),
    purged = Array.from({ length: 3 }, () => view());
  for (const value of purged) await store.write(value, () => true);
  expect(f.slots()).toHaveLength(3);
  // The OS may clear the cache directory at any time; secure storage survives it.
  for (const { name } of f.list()) rmSync(`${f.directory}/${name}`);
  for (let index = 0; index < 4; index++) await store.write(view(), () => true);
  expect(f.slots()).toHaveLength(4);
  for (const value of purged)
    expect(f.slots()).not.toContain(`saved.${value.hostIdentity.deploymentId}`);
});

it("authenticates Account issuer and subject even when the two login IDs and key match", async () => {
  const f = fixture(),
    store = f.open();
  const value = view({
    ...scope(),
    accountSource: {
      issuer: "https://account.test",
      subject: ControlPlaneAccountIdSchema.parse("acct_0192f4a1-3333-4000-8000-000000000003"),
      loginId: globalThis.crypto.randomUUID(),
    },
  });
  await store.write(value, () => true);
  expect(await store.load(value, () => true)).toEqual(value);
  expect(
    await store.load(
      {
        ...value,
        accountSource: { ...value.accountSource!, issuer: "https://other-account.test" },
      },
      () => true,
    ),
  ).toBeNull();
  expect(
    await store.load(
      {
        ...value,
        accountSource: {
          ...value.accountSource!,
          subject: ControlPlaneAccountIdSchema.parse("acct_0192f4a1-3333-4000-8000-000000000004"),
        },
      },
      () => true,
    ),
  ).toBeNull();
});
