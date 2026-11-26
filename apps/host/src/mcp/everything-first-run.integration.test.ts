import { randomUUID } from "node:crypto";
import type { AgentGrant, ThreadAccessMode } from "@opensteer/core";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startBrowserRuntime } from "../browser/browser-runtime.test-support.js";
import { connectAgent } from "../runtime/connected-agent.test-support.js";
import {
  connectCallerMachine,
  startPrivateMachineHost,
  waitForCondition,
} from "../runtime/private-machine-host.test-support.js";
import { testRpcData } from "../server/test-host-api-request.js";

// These need a PostgreSQL test database, which `pnpm test:integration` provides.
const integration = process.env.OPENSTEER_TEST_DATABASE_URL ? describe : describe.skip;

/**
 * A connected agent on a fresh Home: no browser profile yet. Nothing is "not shared" when the
 * person shared everything; there is simply nothing yet, and the agent makes it through the
 * Home's own door, asked of the person as any change to the Home is.
 */
integration("a connected agent's first use of a fresh Home", () => {
  const close: (() => Promise<unknown>)[] = [];
  const after: (() => Promise<unknown>)[] = [];
  let host: Awaited<ReturnType<typeof startPrivateMachineHost>>;
  beforeAll(async () => {
    const database = await cloneTestDatabase("host");
    close.unshift(async () => database.drop?.());
    host = await startPrivateMachineHost(database.url, { logger: false });
    close.unshift(() => host.close());
    const machine = await connectCallerMachine(host, {
      name: "Home computer",
      token: host.hostingRunnerEnrollmentToken,
      browser: {
        runtimeId: "browser-runtime-integration",
        wireVersion: 2,
        cdpBoundary: 1,
        sharedControl: 1,
        tabRestoreVersion: 1,
        surfaceState: 1,
      },
    });
    close.unshift(() => machine.close());
    const browser = await startBrowserRuntime(host.hostPort, "unused-existing-main", {
      primary: machine.primary,
      agentReady: true,
      targetedStreaming: true,
      personalTabs: true,
      surfaceState: true,
      uniqueTabs: true,
      tabCommands: true,
    });
    close.unshift(() => browser.close());
    await waitForCondition(async () => host.runtime.browser.available, 30_000);
    await host.runtime.browser.initialize();
  }, 120_000);
  afterEach(async () => {
    for (const step of after.splice(0)) await step().catch(() => undefined);
    // Each case starts on a Home with no profile and nothing waiting.
    await host.store.database.deleteFrom("browserProfiles").execute();
    await host.store.database
      .updateTable("requests")
      .set({ status: "cancelled" } as never)
      .where("status", "=", "pending")
      .execute();
  });
  afterAll(async () => {
    for (const step of close) await step().catch(() => undefined);
  }, 120_000);

  const profiles = async () =>
    host.store.database
      .selectFrom("browserProfiles")
      .select(["id", "name"])
      .where("ownerId", "=", host.ownerId)
      .execute();
  const waitingCommands = () =>
    host.store.database
      .selectFrom("requests")
      .select("id")
      .where("status", "=", "pending")
      .where("command", "is not", null)
      .execute();
  /** A connected agent's operation waiting for the person (not a proposed command). */
  const waitingWork = () =>
    host.store.database
      .selectFrom("requests")
      .select("id")
      .where("status", "=", "pending")
      .where("command", "is", null)
      .execute();
  const agentWith = async (grant: AgentGrant, mode: ThreadAccessMode) => {
    const agent = await connectAgent(host, grant, mode);
    after.push(() => agent.close());
    return agent;
  };
  const errorOf = (result: { readonly structuredContent?: Record<string, unknown> }) =>
    (result.structuredContent as { error?: { message: string; next: string | null } }).error;

  it.each(["approval-required", "auto"] as const)(
    "tells an Everything connection in %s that the Home has no profile yet, and lets it make one through the door",
    async (mode) => {
      expect(await profiles()).toEqual([]);
      const agent = await agentWith({ scope: "everything" }, mode);
      const create = {
        command: { type: "browser.profile.create", input: { name: "Agent browser" } },
      };

      const discovered = (await agent.call("discover", {})).structuredContent;
      expect(discovered).toMatchObject({ items: [] });
      expect((discovered as { next?: string }).next).toBe(
        'This Home has nothing set up yet. To browse, create a browser profile with opensteer_command {"command":{"type":"browser.profile.create","input":{"name":"<a name>"}}}; opensteer_commands lists what else you can set up.',
      );
      for (const tool of ["browser_use", "browser_connect"] as const) {
        const answer = await agent.call(tool, tool === "browser_use" ? { code: "return 1" } : {});
        expect(errorOf(answer), JSON.stringify(answer)).toMatchObject({
          message: "This Home has no browser profile yet.",
          next: `Create one with opensteer_command {"command":{"type":"browser.profile.create","input":{"name":"<a name>"}}}, then call ${tool} again.`,
        });
      }

      // The person is asked, as for any change to the Home below Full access.
      const asking = agent.call("opensteer_command", create);
      await waitForCondition(async () => (await waitingCommands()).length > 0, 30_000);
      const [request, ...more] = await waitingCommands();
      expect(more).toEqual([]);
      expect(await profiles()).toEqual([]);
      await testRpcData(
        host.origin,
        "commands.dispatch",
        {
          type: "request.command.approve",
          idempotencyKey: randomUUID(),
          requestId: request!.id,
          expectedRevision: (await host.store.requests.revision(request!.id as never))!,
        },
        { headers: host.ownerHeaders },
      );
      // The approval runs the stored command; the agent's own call is answered when its hold ends.
      after.push(() => asking);
      await waitForCondition(async () => (await profiles()).length > 0, 10_000);
      const [made] = await profiles();
      expect(made).toMatchObject({ name: "Agent browser" });

      // Its browser call now reaches the profile it made. Asked as its mode says, the person
      // allows it while the call is held, and the same call runs there.
      let settled = false;
      const using = agent.call("browser_use", { code: "return 1" }).finally(() => {
        settled = true;
      });
      await waitForCondition(async () => settled || (await waitingWork()).length > 0, 10_000);
      for (const { id } of await waitingWork())
        await testRpcData(
          host.origin,
          "commands.dispatch",
          {
            type: "request.respond",
            idempotencyKey: randomUUID(),
            requestId: id,
            expectedRevision: (await host.store.requests.revision(id as never))!,
            response: { kind: "form", answers: { decision: ["allow"] } },
          },
          { headers: host.ownerHeaders },
        );
      const used = (await using).structuredContent;
      expect(used, JSON.stringify(used)).toMatchObject({
        status: "completed",
        profileId: made!.id,
      });
    },
  );

  it("keeps a selected connection's answers about what it was not given as they are", async () => {
    // A selected grant naming a paired Chrome that is not here: it holds the browser tools.
    const agent = await agentWith(
      {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "chrome-tabs", sourceId: `bsr_${randomUUID()}` as never }],
      },
      "approval-required",
    );
    const discovered = (await agent.call("discover", {})).structuredContent;
    expect(discovered).toMatchObject({ items: [] });
    expect((discovered as { next?: string }).next).toBe(
      "Nothing shared with you is here yet. What else you can use is the person's to decide.",
    );
    expect(JSON.stringify(discovered)).not.toContain("browser.profile.create");
    for (const tool of ["browser_use", "browser_connect"] as const) {
      const answer = await agent.call(tool, tool === "browser_use" ? { code: "return 1" } : {});
      expect(errorOf(answer)).toMatchObject({
        message: "No browser profile is shared with this connected agent.",
        next: "Ask the person to share one from Connected agents.",
      });
    }
  });
});
