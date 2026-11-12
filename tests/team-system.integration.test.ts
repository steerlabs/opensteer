import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "kysely";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "../packages/database/src/test-database.test-support.js";
import { startPersonalRuntime } from "../apps/host/src/runtime/personal-startup.test-support.js";
import { TeamLinkNetwork } from "../apps/host/src/team-links/network.js";
import {
  PersonalTeamLinks,
  readTeamReply,
} from "../packages/client/src/host/personal-team-links.js";
import { HttpHostClient } from "../packages/client/src/host/host-session-client.js";
import type { WebSocketClient } from "../packages/client/src/host/host-session-client.js";
import { teamAgentIdentity } from "../packages/client/src/team/presentation.js";
import { TeamLinkViewSchema, type HostApiCommandInput } from "../packages/protocol/src/index.js";
import {
  teamApiVersion,
  teamApiVersionHeader,
} from "../packages/deployment-authority/src/index.js";
import type { RequestResponse } from "../packages/core/src/index.js";
import { WebSocket } from "ws";
import { withTimeout } from "../packages/shared/src/withTimeout.js";
import { expect, it, vi } from "vitest";
import { startTeamSystem, teamCondition, openMachineSocket } from "./team-system.test-support.js";
import { createId, RequestPresentationSchema } from "../packages/core/src/index.js";

it("proves team chat, a personal Runner and revocation end to end", async () => {
  const team = await startTeamSystem();
  const personalDatabases: Awaited<ReturnType<typeof cloneTestDatabase>>[] = [];
  const personals: Awaited<ReturnType<typeof startPersonalRuntime>>[] = [];
  let personalClient: HttpHostClient | undefined;
  const extraTeams: Awaited<ReturnType<typeof startTeamSystem>>[] = [];
  const releasePost = Promise.withResolvers<void>();
  try {
    const maya = await team.setup();
    const session = await team.session(maya, "Maya's phone");
    await session.client.load();
    await teamCondition(
      session.client,
      () => (session.client.getSnapshot().connection === "connected" ? true : undefined),
      "Maya never connected",
    );
    expect(session.client.getSnapshot().bootstrap?.member.displayName).toBe("Maya");
    const invited = await session.rpc["commands.dispatch"]({
      type: "team.invite.create",
      id: (await import("../packages/core/src/index.js")).createId("teamInvite"),
      maxUses: 1,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    if (!invited.ok || invited.data.type !== "team.invite.create")
      throw new Error(JSON.stringify(invited));
    const dev = await team.acceptInvite(invited.data.url, "Dev");
    const devSession = await team.session(dev, "Dev desktop");
    const second = await team.session(maya, "Maya desktop");
    await Promise.all([devSession.client.load(), second.client.load()]);
    const command = async (input: HostApiCommandInput) => {
      const result = await session.rpc["commands.dispatch"](input);
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.data;
    };
    await command({ type: "team.owner.transfer", userId: dev });
    const channelId = createId("teamChannel");
    const created = await session.rpc["commands.dispatch"]({
      type: "team.channel.create",
      id: channelId,
      name: "support",
      kind: "public",
      peopleOnly: false,
      access: [
        { subject: { kind: "person", userId: maya }, level: "post", manage: true },
        { subject: { kind: "person", userId: dev }, level: "post", manage: true },
      ],
    });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    session.client.selectChannel(channelId);
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().channel?.channel ?? undefined,
      "Channel never opened",
    );
    const send = (text: string, threadRootId: string | null = null) =>
      session.rpc["commands.dispatch"]({
        type: "team.message.send",
        channelId,
        threadRootId,
        clientMessageId: crypto.randomUUID(),
        bodyMarkdown: text,
        mentions: [],
        attachmentIds: [],
      });
    const root = await send("Root");
    if (!root.ok || root.data.type !== "team.message.send") throw new Error(JSON.stringify(root));
    session.client.selectThread(channelId, root.data.message.id);
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().thread?.channel ?? undefined,
      "Thread never opened",
    );
    const later = await send("New channel root with a thread open");
    expect(later.ok).toBe(true);
    await teamCondition(
      session.client,
      () =>
        session.client
          .getSnapshot()
          .channel?.messages.some(
            (row) => row.bodyMarkdown === "New channel root with a thread open",
          )
          ? true
          : undefined,
      "Opening a thread stopped live channel delivery",
    );
    const privateId = createId("teamChannel"),
      groupId = createId("teamGroup"),
      groupChannel = createId("teamChannel");
    await command({
      type: "team.channel.create",
      id: privateId,
      name: "private",
      kind: "private",
      peopleOnly: false,
      access: [{ subject: { kind: "person", userId: maya }, level: "post", manage: true }],
    });
    expect(
      (
        await devSession.rpc["team.messages.page"]({
          channelId: privateId,
          page: { direction: "newest" },
        })
      ).ok,
    ).toBe(false);
    await command({ type: "team.group.create", id: groupId, name: "Support" });
    await command({ type: "team.group.person.add", groupId, userId: dev });
    await command({
      type: "team.channel.create",
      id: groupChannel,
      name: "group",
      kind: "private",
      peopleOnly: false,
      access: [
        { subject: { kind: "person", userId: maya }, level: "post", manage: true },
        { subject: { kind: "group", groupId }, level: "post", manage: false },
      ],
    });
    expect(
      (
        await devSession.rpc["team.messages.page"]({
          channelId: groupChannel,
          page: { direction: "newest" },
        })
      ).ok,
    ).toBe(true);

    const routes = new Map([[team.canonicalOrigin, team]]);
    const mismatched = new Set<string>();
    const machineSockets = new Map<string, Set<WebSocket>>();
    vi.spyOn(TeamLinkNetwork.prototype, "discover").mockImplementation(async (origin) => {
      const target = routes.get(origin);
      if (!target) throw new Error("Unknown fixture origin");
      const descriptor = await (
        await fetch(new URL("/.well-known/opensteer", target.origin))
      ).json();
      return mismatched.has(origin)
        ? { ...descriptor, apiVersion: teamApiVersion + 1 }
        : descriptor;
    });
    vi.spyOn(TeamLinkNetwork.prototype, "redeem").mockImplementation(
      async (origin, body, signal) => {
        const target = routes.get(origin);
        if (!target) throw new Error("Unknown fixture origin");
        const response = await fetch(new URL("/internal/v1/team/link/redeem", target.origin), {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            [teamApiVersionHeader]: String(teamApiVersion),
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`Link redeem failed (${response.status})`);
        return TeamLinkViewSchema.parse(await response.json());
      },
    );
    vi.spyOn(TeamLinkNetwork.prototype, "connect").mockImplementation(
      async (origin, secret, signal) => {
        const target = routes.get(origin);
        if (!target) throw new Error("Unknown fixture origin");
        const socket = await openMachineSocket(target.origin, secret, signal);
        const sockets = machineSockets.get(origin) ?? new Set<WebSocket>();
        sockets.add(socket);
        machineSockets.set(origin, sockets);
        socket.once("close", () => sockets.delete(socket));
        return socket;
      },
    );
    console.info("Z4: starting personal hosts");
    const engineArguments = ["--scenario=happy", "--unique-threads"];
    for (const [index, human] of [session, devSession].entries()) {
      const database = await cloneTestDatabase("host");
      personalDatabases.push(database);
      const owned = await ownTestDatabaseProducer(database.url, async () => {
        const runtime = await startPersonalRuntime({
          databaseUrl: database.url,
          agentHome: {
            computerId: createId("runner"),
            path: join(team.directory, `private-home-${index}`),
          },
          engineArguments: index === 0 ? engineArguments : ["--scenario=reasoning"],
        });
        return { runtime, close: () => runtime.close() };
      });
      console.info("Z4: personal runner ready");
      personals.push(owned.runtime);
      const code = await human.rpc["commands.dispatch"]({ type: "team.link.code.create" });
      if (!code.ok || code.data.type !== "team.link.code.create")
        throw new Error(JSON.stringify(code));
      console.info("Z4: linking personal");
      await new PersonalTeamLinks(owned.runtime.api).join(code.data.offer);
    }
    const personal = personals[0]!;
    const folder = {
      computerId: personal.agentHome.computerId,
      path: join(await realpath(team.directory), "remembered-private-folder"),
    };
    await mkdir(folder.path);
    const personalLinks = new PersonalTeamLinks(personal.api);
    await personalLinks.setFolder(team.host.deployment.id, channelId, folder);
    const ask = async (
      text: string,
      threadRootId: string | null = null,
      human = session,
      owner = maya,
    ) => {
      const result = await human.rpc["commands.dispatch"]({
        type: "team.message.send",
        channelId,
        threadRootId,
        bodyMarkdown: text,
        clientMessageId: crypto.randomUUID(),
        mentions: [{ kind: "agent", userId: owner }],
        attachmentIds: [],
      });
      if (!result.ok || result.data.type !== "team.message.send")
        throw new Error(JSON.stringify(result));
      return result.data.message;
    };
    const statusStates = new Set<string>();
    session.client.subscribe(() => {
      const snapshot = session.client.getSnapshot();
      for (const request of [
        ...(snapshot.channel?.messages.flatMap((row) => row.requests) ?? []),
        ...(snapshot.thread?.requests ?? []),
      ])
        statusStates.add(request.state);
    });
    let queued: Awaited<ReturnType<typeof ask>> | undefined;
    console.info("Z4: queuing offline");
    await personal.restartHost({
      whileDown: async () => {
        queued = await ask("@maya-agent please help");
        const requests = await team.database
          .selectFrom("teamAgentRequests")
          .selectAll()
          .where("triggerMessageId", "=", queued.id)
          .execute();
        expect(requests).toHaveLength(1);
        expect(requests[0]!.state).toBe("queued");
        await session.client.refreshSidebar();
        expect(
          session.client.getSnapshot().sidebar?.channels.find((row) => row.channel.id === channelId)
            ?.agentOnline,
        ).toBe(false);
      },
    });
    console.info("Z4: personal restarted");
    if (!queued) throw new Error("No offline question");
    session.client.selectThread(channelId, queued.id);
    console.info("Z4: waiting local input");
    const local = await personal.observe(
      async () => {
        const rows = await personal.host.store.database
          .selectFrom("personalTeamRequests")
          .selectAll()
          .execute();
        return rows[0];
      },
      AbortSignal.timeout(15000),
      "Offline request never became a local input",
    );
    const tasks = await personal.host.store.database
      .selectFrom("threads")
      .selectAll()
      .where("teamId", "=", team.host.deployment.id)
      .execute();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      folderPath: folder.path,
      folderComputerId: folder.computerId,
    });
    const nextRequest = (kind: "choice" | "form") =>
      personal.observe(
        async () => {
          const rows = await personal.host.store.database
            .selectFrom("requests")
            .selectAll()
            .where("originatingThreadId", "=", local.localTaskId)
            .where("status", "=", "pending")
            .execute();
          return rows.find(
            (row) => RequestPresentationSchema.parse(row.presentation).kind === kind,
          );
        },
        AbortSignal.timeout(15000),
        `Private ${kind} request never appeared`,
      );
    console.info("Z4: waiting approval");
    const approval = await nextRequest("choice");
    console.info("Z4: waiting team needs-you");
    await teamCondition(
      session.client,
      () => session.client.getSnapshot().thread?.requests.find((row) => row.state === "needs_you"),
      "Needs-you never reached the team card",
    );
    const choice = RequestPresentationSchema.parse(approval.presentation);
    if (choice.kind !== "choice") throw new Error("Expected approval");
    const allow = choice.options.find(
      (row) => row.hint !== "reject-once" && row.hint !== "cancel",
    )!;
    const answer = async (requestId: typeof approval.id, response: RequestResponse) => {
      const result = await personal.api["commands.dispatch"]({
        type: "request.respond",
        idempotencyKey: crypto.randomUUID(),
        requestId,
        response,
      });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    };
    await answer(approval.id, { kind: "choice", optionId: allow.id });
    console.info("Z4: waiting private question");
    const question = await nextRequest("form");
    const form = RequestPresentationSchema.parse(question.presentation);
    if (form.kind !== "form") throw new Error("Expected private question");
    await answer(question.id, {
      kind: "form",
      answers: Object.fromEntries(
        form.fields.map((field) => [field.id, [field.choices?.[0]?.value ?? "PRIVATE_ANSWER_Z4"]]),
      ),
    });
    console.info("Z4: waiting completed");
    const completed = await personal.waitForInput(local.localInputId, AbortSignal.timeout(15000));
    expect(completed.events.some((event) => event.type === "run.completed")).toBe(true);
    await teamCondition(
      session.client,
      () =>
        session.client
          .getSnapshot()
          .thread?.messages.find(
            (row) => row.authorKind === "agent" && row.bodyMarkdown === "Done.",
          ),
      "Final reply never posted",
    );
    const page = await session.rpc["team.thread.page"]({
      channelId,
      rootId: queued.id,
      page: { direction: "newest" },
    });
    if (!page.ok) throw new Error(JSON.stringify(page.error));
    expect(JSON.stringify(page.data)).not.toContain("PRIVATE_ANSWER_Z4");
    expect(JSON.stringify(page.data)).not.toContain(folder.path);
    const request = await team.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", local.requestId)
      .executeTakeFirstOrThrow();
    expect(request.state).toBe("done");
    const replyMessageId = request.replyMessageId;
    if (replyMessageId === null) throw new Error("The finished request named no reply");
    expect([...statusStates]).toEqual(
      expect.arrayContaining(["queued", "working", "needs_you", "done"]),
    );
    expect(request.steps.length).toBeGreaterThan(0);
    expect(request.steps.every((step) => Object.keys(step).sort().join() === "count,kind")).toBe(
      true,
    );
    const members = await session.rpc["team.members.list"]({});
    if (!members.ok) throw new Error(JSON.stringify(members.error));
    expect(
      teamAgentIdentity(
        members.data.members.find((row) => row.userId === maya)!,
        dev,
      ).label,
    ).toBe("Maya's agent");
    const count = await team.database.selectFrom("teamAgentRequests").select("id").execute();
    await ask("@maya-agent from Dev", queued.id, devSession, maya);
    expect(await team.database.selectFrom("teamAgentRequests").select("id").execute()).toHaveLength(
      count.length,
    );

    console.info("Z4: reading local task");
    personalClient = new HttpHostClient({
      baseUrl: personal.hostOrigin,
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...Object.fromEntries(new Headers(init?.headers)),
            cookie: personal.sessionCookie,
            origin: personal.hostOrigin.origin,
          },
        }),
      webSocketFactory: (url) =>
        new WebSocket(url, {
          headers: { cookie: personal.sessionCookie, origin: personal.hostOrigin.origin },
        }) as unknown as WebSocketClient,
    });
    await personalClient.load();
    await readTeamReply(personalClient, {
      teamId: team.host.deployment.id,
      channelId,
      threadRootId: queued.id,
      replyMessageId,
    });
    expect(personalClient.getSnapshot().threadReadStates[local.localTaskId]?.readSequence).toBe(
      personalClient.getSnapshot().threadReadStates[local.localTaskId]?.unreadSequence,
    );

    console.info("Z4: SQL continuation");
    engineArguments.splice(
      0,
      engineArguments.length,
      "--scenario=notifications",
      "--unique-threads",
    );
    await personal.restartRunner();
    const topic = (
      await sql<{
        id: string;
      }>`select id from knowledge.topics where origin_channel_id=${channelId}`.execute(
        team.database,
      )
    ).rows[0]!;
    const call = (name: string, input: unknown) =>
      `[[call ${name} ${Buffer.from(JSON.stringify(input)).toString("base64url")}]]`;
    await ask(
      [
        call("sql", {
          mode: "write",
          sql: "INSERT INTO facts(topic,thing,property,value) VALUES ($1,'z4','answer','42')",
          parameters: [topic.id],
          operationId: crypto.randomUUID(),
        }),
        call("sql", {
          mode: "read",
          sql: "SELECT 42 / count(*) AS result FROM facts WHERE thing='z4' AND value='42'::jsonb",
          parameters: [],
        }),
        "[[reply Knowledge written and read.]]",
      ].join("\n"),
      queued.id,
    );
    await teamCondition(
      session.client,
      () =>
        session.client
          .getSnapshot()
          .thread?.messages.find((row) => row.bodyMarkdown === "Knowledge written and read."),
      "Agent SQL continuation did not finish",
    );
    expect(
      await personal.host.store.database
        .selectFrom("threads")
        .select("id")
        .where("teamId", "=", team.host.deployment.id)
        .execute(),
    ).toHaveLength(1);
    expect(
      (
        await sql<{
          count: string;
        }>`select count(*)::text as count from knowledge.fact_log where thing='z4'`.execute(
          team.database,
        )
      ).rows[0]!.count,
    ).toBe("1");

    const hold = await ask("[[hold]]");
    const held = await personal.observe(
      async () => {
        const row = await personal.host.store.database
          .selectFrom("personalTeamRequests")
          .selectAll()
          .where("triggerMessageId", "=", hold.id)
          .executeTakeFirst();
        if (!row) return;
        const run = await personal.host.store.database
          .selectFrom("runs")
          .selectAll()
          .where("teamRequestId", "=", row.requestId)
          .where("status", "=", "running")
          .executeTakeFirst();
        return run;
      },
      AbortSignal.timeout(15000),
      "Held run never started",
    );
    await command({ type: "team.channel.update", channelId, name: "support", peopleOnly: true });
    const afterSwitch = await team.database
      .selectFrom("teamMessages")
      .select("id")
      .where("authorKind", "=", "agent")
      .execute();
    expect(
      (
        await team.database
          .selectFrom("teamAgentRequests")
          .select("state")
          .where("triggerMessageId", "=", hold.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("cancelled");
    await personal.observe(
      async () => {
        const row = await personal.host.store.database
          .selectFrom("runs")
          .select("status")
          .where("id", "=", held.id)
          .executeTakeFirstOrThrow();
        return ["interrupted", "failed"].includes(row.status) ? true : undefined;
      },
      AbortSignal.timeout(15000),
      "People-only failed to stop local execution",
    );
    expect(
      await team.database
        .selectFrom("teamMessages")
        .select("id")
        .where("authorKind", "=", "agent")
        .execute(),
    ).toHaveLength(afterSwitch.length);
    await command({ type: "team.channel.update", channelId, name: "support", peopleOnly: false });
    const pendingPost = Promise.withResolvers<void>();
    const postFinished = Promise.withResolvers<boolean>();
    const originalReply = team.host.team.requests.reply.bind(team.host.team.requests);
    vi.spyOn(team.host.team.requests, "reply").mockImplementation(async (...args) => {
      pendingPost.resolve();
      await withTimeout(releasePost.promise, 10000, {
        timeoutError: () => new Error("Pending team post was not released"),
      });
      try {
        const result = await originalReply(...args);
        postFinished.resolve(true);
        return result;
      } catch (error) {
        postFinished.resolve(false);
        throw error;
      }
    });
    await ask("[[reply Must never post after removal.]]");
    await withTimeout(pendingPost.promise, 15000, {
      timeoutError: () => new Error("Final reply never reached the pending-post barrier"),
    });
    const removed = await devSession.rpc["commands.dispatch"]({
      type: "team.member.remove",
      userId: maya,
    });
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    releasePost.resolve();
    expect(
      await withTimeout(postFinished.promise, 5000, {
        timeoutError: () => new Error("Revoked pending post did not settle"),
      }),
    ).toBe(false);
    expect(
      (
        await session.rpc["team.thread.page"]({
          channelId,
          rootId: queued.id,
          page: { direction: "newest" },
        })
      ).ok,
    ).toBe(false);
    expect(
      await team.database
        .selectFrom("teamMessages")
        .select("id")
        .where("authorKind", "=", "agent")
        .execute(),
    ).toHaveLength(afterSwitch.length);
    const other = await startTeamSystem("Other");
    extraTeams.push(other);
    routes.set(other.canonicalOrigin, other);
    const otherOwner = await other.setup(),
      otherSession = await other.session(otherOwner, "Other team owner");
    const offer = await otherSession.rpc["commands.dispatch"]({ type: "team.link.code.create" });
    if (!offer.ok || offer.data.type !== "team.link.code.create")
      throw new Error(JSON.stringify(offer));
    const devLinks = new PersonalTeamLinks(personals[1]!.api);
    await devLinks.join(offer.data.offer);
    mismatched.add(team.canonicalOrigin);
    for (const socket of machineSockets.get(team.canonicalOrigin) ?? []) socket.terminate();
    await vi.waitFor(
      async () => {
        const links = await devLinks.list();
        expect(links.find((link) => link.teamId === team.host.deployment.id)?.state).toBe(
          "needs_update",
        );
        expect(links.find((link) => link.teamId === other.host.deployment.id)?.state).toBe(
          "active",
        );
      },
      { timeout: 10000 },
    );
    expect((await personals[1]!.api["bootstrap.get"]({})).ok).toBe(true);
  } finally {
    releasePost.resolve();
    personalClient?.dispose();
    for (const personal of personals.reverse()) await personal.close();
    for (const database of personalDatabases.reverse()) await database.drop();
    for (const extra of extraTeams.reverse()) await extra.close();
    await team.close();
    vi.restoreAllMocks();
  }
}, 120000);
