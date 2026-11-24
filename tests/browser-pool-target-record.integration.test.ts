// The Home's record of its pooled browser's registration and target (phase B, piece 4), in its
// own database: the attempt is open from before the registration leaves until its answer, or a
// read that shows it never arrived, closes it.
import { afterEach, expect, it } from "vitest";
import { databaseManagedBrowserPoolTargetRecord } from "../apps/host/src/browser/managed-pool-target.js";
import { createStoreFixture } from "../packages/database/src/store.integration.test-support.js";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

it("keeps a registration's attempt open until its own answer, or a read that shows it never arrived", async () => {
  const fixture = await createStoreFixture();
  open.push(() => fixture.close());
  const record = databaseManagedBrowserPoolTargetRecord(fixture.database, "cc_record");
  expect(await record.read()).toBeUndefined();
  const keys = { homeKey: "h", relayKey: "r", ticketKey: { keyId: "k", spki: "s" } };
  await record.attempt(keys, new Date());
  expect(await record.read()).toMatchObject({ attemptKeys: keys, registeredKeys: null });
  // A read of the target that shows something registered leaves the attempt open.
  await record.answer({ response: { status: "preparing" } });
  expect(await record.read()).toMatchObject({ attemptKeys: keys, status: "preparing" });
  // A read that shows nothing registered: it never arrived.
  await record.answer({ response: { status: "unregistered" }, attemptUnreceived: true });
  expect(await record.read()).toMatchObject({ attemptKeys: null, registeredKeys: null });
  // Its own answer: the keys are registered, the attempt closed, the target kept.
  await record.attempt(keys, new Date());
  const target = { kind: "managed-pool", slotId: "bps_x", term: 1 };
  await record.answer({
    response: { status: "ready", target: target as never },
    registered: keys,
  });
  expect(await record.read()).toMatchObject({
    attemptKeys: null,
    registeredKeys: keys,
    status: "ready",
    target,
  });
});
