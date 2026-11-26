import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAgent } from "../runtime/connected-agent.test-support.js";
import {
  connectCallerMachine,
  startPrivateMachineHost,
  waitForCondition,
} from "../runtime/private-machine-host.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";

/** The plugin engine's fixture npm registry and files, which live outside this package's source. */
interface PluginFixture {
  pluginFixtureFiles(revision: number): { readonly path: string; readonly content: string }[];
  pluginFixtureRegistry(
    waiting?: () => void,
    catalogFiles?: readonly { readonly path: string; readonly content: string }[],
  ): Promise<{ readonly origin: string; readonly address: string; close(): Promise<void> }>;
}
const pluginFixture = () =>
  import(
    fileURLToPath(new URL("../../../../scripts/plugin-engine/fixture.ts", import.meta.url))
  ) as Promise<PluginFixture>;

// These need a PostgreSQL test database, which `pnpm test:integration` provides.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

/**
 * A supervised connected agent and a plugin the person installed: its write tool is offered and
 * asked about, as every write of a supervised connection is, never withheld.
 */
integration("an installed plugin's write under a supervised connection", () => {
  const close: (() => Promise<unknown>)[] = [];
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>>;
  beforeAll(async () => {
    const database = await cloneTestDatabase("host");
    close.unshift(async () => database.drop?.());
    const { pluginFixtureFiles, pluginFixtureRegistry } = await pluginFixture();
    const registry = await pluginFixtureRegistry(undefined, pluginFixtureFiles(1));
    close.unshift(() => registry.close());
    host = await startPrivateMachineHost(database.url, {
      logger: false,
      pluginEngine: {
        npmRegistry: registry.origin,
        catalogUrl: `${registry.origin}/catalog`,
        selfOrigin: { origin: "https://api.fixture.invalid", address: registry.address },
      },
    });
    close.unshift(() => host.close());
    const machine = await connectCallerMachine(host, {
      name: "Home computer",
      token: host.hostingRunnerEnrollmentToken,
    });
    close.unshift(() => machine.close());
    // A plugin with one write tool, installed by the person.
    const files = [
      ...pluginFixtureFiles(1).filter((file) => file.path !== "index.ts"),
      {
        path: "index.ts",
        content: `
import { defineApp, object, string, mutation, router } from "apps";
const tick = mutation({ input: object({ source: string() }) }, async (_ctx, { source }) => "ticked " + source);
export default defineApp({}, { tools: router({ tick }) });`,
      },
    ];
    const installed = (await host.runtime.plugins.install(
      { kind: "files", name: "Ticker", files },
      { caller: "personal", mode: "automatic" } as never,
    )) as { status: string };
    if (installed.status !== "installed")
      throw new Error(`The plugin did not build: ${JSON.stringify(installed)}`);
  }, 300_000);
  afterAll(async () => {
    for (const step of close) await step().catch(() => undefined);
  }, 120_000);

  const waitingRequests = () =>
    host.store.database
      .selectFrom("requests")
      .select("id")
      .where("status", "=", "pending")
      .execute();
  const ticks = async () =>
    (
      await host.store.database
        .selectFrom("pluginExecutions")
        .select("id")
        .where("state", "=", "completed")
        .where("connectionId", "is not", null)
        .execute()
    ).length;
  const answerRequest = async (requestId: string, decision: "allow" | "deny") =>
    testRpcData(
      host.origin,
      "commands.dispatch",
      {
        type: "request.respond",
        idempotencyKey: randomUUID(),
        requestId,
        expectedRevision: (await host.store.requests.revision(requestId as never))!,
        response: { kind: "form", answers: { decision: [decision] } },
      },
      { headers: host.ownerHeaders },
    );

  it("offers it, asks the person once, runs it once when allowed and not at all when refused", async () => {
    const agent = await connectAgent(host, { scope: "everything" }, "approval-required");
    close.unshift(() => agent.close());
    const root = (await agent.call("discover", { query: "Ticker" })).structuredContent as {
      items: { id: string; name: string; access?: string }[];
    };
    const item = root.items.find(({ name }) => name === "Ticker");
    expect(item, JSON.stringify(root)).toMatchObject({ access: "read-write" });
    const detail = JSON.stringify(await agent.call("discover", { id: item!.id }));
    expect(detail).toContain("tick");
    expect(detail).not.toContain("runs read-only");
    const tick = (operationKey: string) =>
      agent.call("plugin_call", {
        calls: { path: `${item!.id}.tick`, input: { source: "agent" } },
        operationKey,
      });
    // The Host holds the call while the person is asked: exactly one Request waits and nothing
    // has run; the person's answer settles the same call.
    const asked = async (operationKey: string) => {
      const call = tick(operationKey);
      await waitForCondition(async () => (await waitingRequests()).length > 0);
      const [request, ...more] = await waitingRequests();
      expect(more).toEqual([]);
      return { call, requestId: request!.id };
    };
    const before = await ticks();
    const allowed = await asked("supervised-tick");
    expect(await ticks()).toBe(before);
    await answerRequest(allowed.requestId, "allow");
    expect(JSON.stringify(await allowed.call)).toContain("ticked agent");
    expect(await ticks()).toBe(before + 1);

    const refused = await asked("supervised-tick-refused");
    await answerRequest(refused.requestId, "deny");
    expect(JSON.stringify(await refused.call)).toContain("The person did not allow it.");
    expect(await ticks()).toBe(before + 1);
    expect(await waitingRequests()).toEqual([]);
  });

  it("refuses the write to a connection whose grant reads the plugin only, asking nobody", async () => {
    const plugin = (
      (await testRpcData(
        host.origin,
        "plugins.installed.list",
        {},
        {
          headers: host.ownerHeaders,
        },
      )) as { plugins: { id: string; name: string }[] }
    ).plugins.find(({ name }) => name === "Ticker");
    if (!plugin) throw new Error("The plugin is not installed");
    const agent = await connectAgent(
      host,
      {
        scope: "selected",
        tasks: false,
        resources: [
          { kind: "plugin", target: { kind: "installed", pluginId: plugin.id }, access: "read" },
        ],
      },
      "approval-required",
    );
    close.unshift(() => agent.close());
    const root = (await agent.call("discover", { query: "Ticker" })).structuredContent as {
      items: { id: string; name: string }[];
    };
    const item = root.items.find(({ name }) => name === "Ticker");
    const before = await ticks();
    const refused = await agent.call("plugin_call", {
      calls: { path: `${item!.id}.tick`, input: { source: "read grant" } },
      operationKey: "read-grant-tick",
    });
    expect(refused.structuredContent).toMatchObject({
      error: { code: "not_found", message: "That item is unavailable." },
    });
    expect(await waitingRequests()).toEqual([]);
    expect(await ticks()).toBe(before);
  });
});
