import { OpensteerError, TabIdSchema } from "@opensteer/core";
import { TabStore, type DatabaseSchema } from "@opensteer/database";
import { createStoreFixture } from "@opensteer/database/test-support/store";
import type { PersonShowMessage } from "@opensteer/protocol";
import type { Kysely } from "kysely";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ProductToolHandlers } from "./handlers/product.js";
import type { RunCaller } from "./agent-caller.js";
import { person_show } from "@opensteer/agent-tools/tools";

const integration = describe.skipIf(!process.env.OPENSTEER_TEST_DATABASE_URL);
integration("explicit person_show", () => {
  it("delivers the exact tab or task, deduplicates delivery, and refuses a closed tab", async () => {
    const fixture = await createStoreFixture(),
      f = await fixture.startRunFixture("show");
    const tabs = new TabStore(fixture.database as unknown as Kysely<DatabaseSchema>);
    const tabId = TabIdSchema.parse(`tab_${randomUUID()}`);
    await tabs.open(
      {
        id: tabId,
        kind: "phone",
        computerId: f.runnerId,
        ownerId: f.userId,
        title: "Phone",
        openedBy: { taskId: f.threadId },
      },
      "phone",
    );
    const messages: PersonShowMessage[] = [];
    let devices = 1;
    const product = new ProductToolHandlers({
      deploymentId: f.deploymentId,
      store: fixture.store,
      commands: {} as never,
      threads: {} as never,
      realtime: {} as never,
      browser: {} as never,
      browserSources: {} as never,
      savedLogins: {} as never,
      deviceAccess: {} as never,
      machineFullDiskAccess: {} as never,
      canRunHarness: () => true,
      harnessAccessModes: () => ["full-access"],
      isEnvironmentConnected: () => true,
      onEvent: () => {},
      execution: {} as never,
      tabs: {
        get: async () => {
          throw new Error("Unexpected tab read");
        },
        authorizeShow: async (claims, id) => {
          if (!(await tabs.get(claims.requestedBy, id)))
            throw new OpensteerError({ code: "not_found", message: "Tab not found." });
        },
      },
      personShow: async (_owner, message) => {
        messages.push(message);
        return devices;
      },
    });
    const caller: RunCaller = {
      kind: "run",
      key: `run:${f.runId}`,
      userId: f.userId,
      thread: f.thread,
      accessMode: f.thread.accessMode,
      claims: {
        aud: "opensteer-run-tools",
        iss: "opensteer-host",
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
        jti: randomUUID(),
        requestedBy: f.userId,
        threadId: f.threadId,
        runId: f.runId,
        environmentId: f.environmentId,
        runnerId: f.runnerId,
        runnerBootId: f.runnerBootId,
        bindingGeneration: f.bindingGeneration,
      },
    };
    const call = {
      caller,
      input: person_show.input.parse({ target: { tabId } }),
      operationKey: "show-phone",
    };
    expect(await product.person_show(call)).toEqual({
      status: "sent-unconfirmed",
      connectedDevices: 1,
    });
    expect(await product.person_show(call)).toEqual({
      status: "already-requested",
      connectedDevices: 0,
    });
    expect(messages).toEqual([
      { type: "host.show", threadId: f.threadId, runId: f.runId, target: { tabId } },
    ]);
    devices = 0;
    expect(
      await product.person_show({
        caller,
        input: { target: { taskId: f.threadId } },
        operationKey: "task",
      }),
    ).toEqual({ status: "no-device-connected", connectedDevices: 0 });
    expect(messages[1]?.target).toEqual({ taskId: f.threadId });
    await tabs.close(f.userId, [tabId], "close");
    await expect(product.person_show({ ...call, operationKey: "closed" })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(messages).toHaveLength(2);
    expect(person_show.input.safeParse({ target: { current: true } }).success).toBe(false);
    expect(person_show.input.safeParse({ target: { runId: f.runId } }).success).toBe(false);
  });
});
