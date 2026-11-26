import { randomUUID } from "node:crypto";
import type { AgentGrant, ThreadAccessMode } from "@opensteer/core";
import { cloneTestDatabase } from "@opensteer/database/test-support/database";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdministrationService } from "../administration/administration-service.js";
import { startBrowserRuntime } from "../browser/browser-runtime.test-support.js";
import { connectAgent } from "../runtime/connected-agent.test-support.js";
import { openRealtime } from "../runtime/machine-access-protocol.test-support.js";
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

      // The person is asked, as for any change to the Home below Full access (at Full access the
      // profile is made at once: the case below). Made without asking ends the wait at once.
      let asked: string | undefined;
      const asking = agent.call("opensteer_command", create).then((answer) => {
        asked = (answer.structuredContent as { status?: string } | undefined)?.status;
        return answer;
      });
      await waitForCondition(
        async () => asked === "done" || (await waitingCommands()).length > 0,
        30_000,
      );
      expect(asked, "the profile was made without asking the person").not.toBe("done");
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

  const create = { command: { type: "browser.profile.create", input: { name: "Agent browser" } } };
  /** The commands the Home recorded as made by this connection: its evidence of what it did. */
  const recordedBy = async (connectionId: string) =>
    (
      await host.store.database
        .selectFrom("commands")
        .select(["type", "authoritySource", "requestedBy", "status"])
        .where("type", "=", "browser.profile.create")
        .execute()
    ).filter(
      ({ authoritySource }) =>
        (authoritySource as { callerKey?: string }).callerKey === `connection:${connectionId}`,
    );

  it("makes the profile at once for an Everything connection at Full access: the person's, attributed to the connection, on the person's screens", async () => {
    // The person's screen, interested in their profiles, as every client of theirs is.
    const realtime = await openRealtime(host, host.ownerHeaders, ["browser-profile"]);
    after.push(() => realtime.close());
    const agent = await agentWith({ scope: "everything" }, "full-access");
    const seen = realtime.messages.length;

    const made = (await agent.call("opensteer_command", create)).structuredContent;
    expect(made, JSON.stringify(made)).toMatchObject({ status: "done" });
    // Nobody was asked: the person gave this when they chose Everything at Full access.
    expect(await waitingCommands()).toEqual([]);
    const [profile, ...more] = await profiles();
    expect(more).toEqual([]);
    expect(profile).toMatchObject({ name: "Agent browser" });
    // The person's profile, made by this connection: the Home's record names it.
    expect(await recordedBy(agent.id)).toEqual([
      {
        type: "browser.profile.create",
        authoritySource: {
          kind: "mcp",
          callerKind: "connection",
          callerKey: `connection:${agent.id}`,
        },
        requestedBy: host.ownerId,
        status: "succeeded",
      },
    ]);
    // The person's screens are told, without a reload.
    await waitForCondition(
      async () =>
        realtime.messages
          .slice(seen)
          .some((message) => JSON.stringify(message).includes("browser-profile")),
      10_000,
    );
    // And its browser works there at once.
    const used = (await agent.call("browser_use", { code: "return 1" })).structuredContent;
    expect(used, JSON.stringify(used)).toMatchObject({
      status: "completed",
      profileId: profile!.id,
    });
  });

  it("still asks the person when a selected connection at Full access makes a profile", async () => {
    const agent = await agentWith(
      {
        scope: "selected",
        tasks: false,
        resources: [{ kind: "chrome-tabs", sourceId: `bsr_${randomUUID()}` as never }],
      },
      "full-access",
    );
    const asking = agent.call("opensteer_command", create);
    after.push(() => asking);
    await waitForCondition(async () => (await waitingCommands()).length > 0, 30_000);
    expect(await profiles()).toEqual([]);
    expect(await recordedBy(agent.id)).toEqual([]);
  });

  it("leaves no profile, or one with its record, when the person disconnects the agent as it makes one", async () => {
    const disconnect = (connectionId: string) =>
      testRpcData(
        host.origin,
        "commands.dispatch",
        { type: "connection.revoke", connectionId, idempotencyKey: randomUUID() },
        { headers: host.ownerHeaders },
      );
    // The person's Disconnect before the call, once the door has begun the command (its attempt
    // is written before anything is done), and after the command has answered.
    for (const when of ["before", "begun", "after"] as const) {
      const agent = await agentWith({ scope: "everything" }, "full-access");
      if (when === "before") await disconnect(agent.id);
      let settled = false;
      const making = agent
        .call("opensteer_command", create)
        .then((result) => result.structuredContent)
        .catch((error: unknown) => ({ error: String(error) }))
        .finally(() => {
          settled = true;
        });
      if (when === "begun") {
        await waitForCondition(
          async () =>
            settled ||
            (
              await host.store.database
                .selectFrom("commandAttempts")
                .select("id")
                .where("connectionId", "=", agent.id)
                .execute()
            ).length > 0,
          10_000,
        );
        await disconnect(agent.id);
      }
      const answer = await making;
      if (when === "after") await disconnect(agent.id);
      const made = await profiles();
      const recorded = await recordedBy(agent.id);
      const seen = JSON.stringify({ when, answer, made, recorded });
      // Never half: a profile always has the record of who made it, and a record its profile.
      expect(made.length, seen).toBe(recorded.length);
      expect(made.length, seen).toBeLessThanOrEqual(1);
      if ((answer as { status?: string }).status === "done") expect(made, seen).toHaveLength(1);
      // What did not happen is never said to be what may have happened (rule 4).
      if (made.length === 0)
        expect((answer as { error?: { code?: string } }).error?.code, seen).not.toBe(
          "outcome_unknown",
        );
      // Disconnected first, nothing is made; made first, it stays the person's, with its record.
      if (when === "before") expect(made, seen).toEqual([]);
      if (when === "after") expect(made, seen).toHaveLength(1);
      await host.store.database.deleteFrom("browserProfiles").execute();
    }
  });

  it.each(["browser.profile.create", "browser.profile.delete"] as const)(
    "re-admits %s where it is written as the door admitted it: a task lowered below Full access in between refuses it",
    async (type) => {
      const agent = await agentWith({ scope: "everything" }, "full-access");
      // A profile, and the connection's own direct session in a task, at Full access.
      expect((await agent.call("opensteer_command", create)).structuredContent).toMatchObject({
        status: "done",
      });
      const [made] = await profiles();
      const used = (await agent.call("browser_use", { code: "return 1" })).structuredContent;
      expect(used, JSON.stringify(used)).toMatchObject({ status: "completed" });
      const { threadId } = await host.store.database
        .selectFrom("agentSessions")
        .select("threadId")
        .where("connectionId", "=", agent.id)
        .where("status", "=", "active")
        .executeTakeFirstOrThrow();
      // The door admits the command as that session; its handler is held before it writes.
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const execute = AdministrationService.prototype.execute;
      const held = vi
        .spyOn(AdministrationService.prototype, "execute")
        .mockImplementationOnce(async function (this: AdministrationService, ...args) {
          entered.resolve();
          await release.promise;
          return execute.apply(this, args);
        });
      after.push(async () => {
        release.resolve();
        held.mockRestore();
      });
      const command =
        type === "browser.profile.create"
          ? { type, input: { name: "Second browser" } }
          : { type, profileId: made!.id };
      const answering = agent.call("opensteer_command", { command });
      await entered.promise;
      // The person lowers that task below Full access while the command is held.
      await host.store.updateThreadAccessMode({
        threadId: threadId!,
        requestedBy: host.ownerId,
        accessMode: "approval-required",
      });
      release.resolve();
      const answer = (await answering).structuredContent;
      const seen = JSON.stringify(answer);
      // Refused before anything happened, as the door would now answer: nothing changed.
      expect(answer, seen).toMatchObject({ error: { code: "access_changed" } });
      expect(
        (await profiles()).map(({ id }) => id),
        seen,
      ).toEqual([made!.id]);
    },
  );

  it("tells a Full access connection when no computer can hold a profile, as refused, never as maybe done", async () => {
    const agent = await agentWith({ scope: "everything" }, "full-access");
    // No computer of this Home can hold a browser profile now.
    const homes = vi.spyOn(host.store, "listEligibleBrowserRunners").mockResolvedValueOnce([]);
    after.push(async () => homes.mockRestore());
    const answer = (await agent.call("opensteer_command", create)).structuredContent;
    const seen = JSON.stringify(answer);
    expect(answer, seen).toMatchObject({
      error: { message: "No computer can hold your browser profiles." },
    });
    expect(homes).toHaveBeenCalled();
    expect(await profiles()).toEqual([]);
    // Its attempt is settled as refused: nothing happened, so nothing is left unknown.
    expect(
      await host.store.database
        .selectFrom("commandAttempts")
        .select("state")
        .where("connectionId", "=", agent.id)
        .execute(),
    ).toEqual([{ state: "failed" }]);
  });

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
