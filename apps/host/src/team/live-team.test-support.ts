import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { WebSocket } from "ws";
import { expect, vi } from "vitest";
import { createId, type TeamActor, type UserId, type AuthenticatedSession } from "@opensteer/core";
import { createTeamKnowledgeFixture } from "@opensteer/database/test-support/team-knowledge";
import { ownTestDatabaseProducer } from "@opensteer/database/test-support/database";
import { teamApiVersion } from "@opensteer/deployment-authority";
import { type TeamLinkServerFrame } from "@opensteer/protocol";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { startTeamServices } from "./services.js";
import { createTeamMachineAdapters } from "./machine-adapters.js";
import {
  createTeamLinkEndpoint,
  TeamLinkLifetimes,
  registerTeamLinkRoutes,
} from "../team-link-endpoint/index.js";
import { TeamLinkConnection } from "../team-links/connection.js";

export async function createLiveTeamFixture() {
  const f = await createTeamKnowledgeFixture();
  const directory = await mkdtemp(join(tmpdir(), "team-review-"));
  const app = Fastify();
  const lifetimes = new TeamLinkLifetimes();
  const connections = new Set<TeamLinkConnection>();
  let services: Awaited<ReturnType<typeof startTeamServices>> | undefined;
  let closing: Promise<void> | undefined;
  const resource = await ownTestDatabaseProducer(f.databaseUrl, async () => ({
    close: () =>
      (closing ??= (async () => {
        for (const current of connections) current.stop();
        lifetimes.stop();
        await app.close();
        await services?.close();
        await rm(directory, { recursive: true, force: true });
      })()),
  }));
  let machine: ReturnType<typeof createTeamLinkEndpoint> | undefined;
  const team = await startTeamServices({
    kind: "team",
    database: f.database,
    teamId: f.deploymentId,
    teamName: "Acme",
    hostKeyFingerprint: `sha256:${"A".repeat(43)}`,
    origin: "https://team.example.invalid",
    dataDirectory: directory,
    knowledge: {
      async read() {
        throw new Error("Unexpected knowledge read");
      },
      async command() {
        throw new Error("Unexpected knowledge command");
      },
    },
    machine: {
      deliver: async (id) => {
        await machine?.endpoint.deliver(id);
      },
      cancel: (id, requestId) => machine?.endpoint.cancel(id, requestId),
      close: (effects) => lifetimes.close(effects),
      isOnline: (ownerUserId) => machine?.endpoint.isOnline(ownerUserId) ?? false,
    },
    async publishPush() {},
    backgroundError() {},
  });
  services = team;
  machine = createTeamLinkEndpoint({
    database: f.database,
    teamName: "Acme",
    requests: team.requests,
    access: team.access,
    resolver: team.access,
    lifetimes,
    ...createTeamMachineAdapters(team, {
      async topics() {
        throw new Error("Unexpected knowledge call");
      },
      async readNotes() {
        throw new Error("Unexpected knowledge call");
      },
      async write() {
        throw new Error("Unexpected knowledge call");
      },
    }),
    onPresence: (ownerUserId, online) => {
      void team.realtime.linkPresenceChanged(ownerUserId, online);
    },
  });
  await app.register(websocket);
  await registerTeamLinkRoutes(app, machine.endpoint, machine.binary);
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  const actor = (userId: UserId): TeamActor => ({ kind: "human", userId });
  const owner = actor(f.userId);
  const memberId = await f.member("ReviewMember");
  const member = actor(memberId);
  const channel = await team.chat.create(owner, {
    id: createId("teamChannel"),
    name: "support",
    kind: "private",
    peopleOnly: false,
    access: [{ subject: { kind: "person", userId: memberId }, level: "post", manage: true }],
  });
  const linkId = createId("teamLink");
  const secret = `ost_link_${randomBytes(32).toString("base64url")}`;
  await f.database
    .insertInto("teamLinks")
    .values({
      id: linkId,
      ownerUserId: memberId,
      state: "active",
      personalDeploymentId: createId("deployment"),
      codeHash: randomUUID(),
      codeExpiresAt: new Date(),
      credentialHash: createHash("sha256").update(secret).digest("hex"),
    })
    .execute();
  const frames: TeamLinkServerFrame[] = [];
  let readyCount = 0;
  let connection: TeamLinkConnection | undefined;
  const sockets = new Set<WebSocket>();
  const connect = async () => {
    connection = new TeamLinkConnection({
      teamId: f.deploymentId,
      open: async () => {
        const socket = new WebSocket(`${origin.replace("http", "ws")}/internal/v1/team/link`, {
          headers: {
            authorization: `Bearer ${secret}`,
            "x-opensteer-team-api-version": String(teamApiVersion),
          },
        });
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        await withTimeout(once(socket, "open"), 5000, {
          timeoutError: () => new Error("Machine socket never opened"),
        });
        return socket;
      },
      terminalRequests: async () => [],
      onReady: async () => {
        readyCount++;
      },
      onFrame: async (frame) => {
        frames.push(frame);
      },
      onState: async () => {},
    });
    const before = readyCount;
    connections.add(connection);
    connection.start();
    await vi.waitFor(() => expect(readyCount).toBeGreaterThan(before), { timeout: 5000 });
    return connection;
  };
  const ask = async () => {
    const result = await team.chat.send(member, {
      channelId: channel.id,
      threadRootId: null,
      clientMessageId: randomUUID(),
      bodyMarkdown: "@reviewmember-agent Help",
      mentions: [{ kind: "agent", userId: memberId }],
      attachmentIds: [],
    });
    return f.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("triggerMessageId", "=", result.message.id)
      .executeTakeFirstOrThrow();
  };
  const session = async (userId: UserId): Promise<AuthenticatedSession> => {
    const id = createId("authSession"),
      now = new Date().toISOString(),
      expiresAt = new Date(Date.now() + 60000).toISOString();
    await f.database
      .insertInto("authSessions")
      .values({
        id,
        userId,
        token: randomUUID(),
        memberGeneration: "1",
        deviceLabel: "Review",
        expiresAt: new Date(expiresAt),
        absoluteExpiresAt: new Date(expiresAt),
      })
      .execute();
    return {
      id,
      createdAt: now,
      expiresAt,
      absoluteExpiresAt: expiresAt,
      user: {
        id: userId,
        displayName: "Review",
        email: "review@example.invalid",
        emailVerified: true,
        image: null,
        disabledAt: null,
      },
    };
  };
  return {
    ...f,
    team,
    machine,
    origin,
    secret,
    linkId,
    owner,
    member,
    channel,
    actor,
    frames,
    connect,
    ask,
    session,
    addMember: f.member,
    get readyCount() {
      return readyCount;
    },
    get connection() {
      return connection!;
    },
    async disconnect() {
      for (const current of connections) current.stop();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    },
    async waitForSockets(count: number) {
      await vi.waitFor(() => expect(sockets.size).toBe(count));
    },
    async close() {
      await resource.close();
      await f.close();
    },
  };
}
