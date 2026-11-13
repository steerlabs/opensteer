import fastify from "fastify";
import websocket from "@fastify/websocket";
import { createHash, randomBytes, randomUUID, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { Readable, PassThrough } from "node:stream";
import { WebSocket } from "ws";
import { sql } from "kysely";
import { expect, vi } from "vitest";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { AesGcmCredentialVault, StaticEncryptionKeyProvider } from "@opensteer/access/host";
import {
  createId,
  SequenceSchema,
  type TeamAgentRequestId,
  type TeamMessageId,
  type TeamSource,
} from "@opensteer/core";
import type { TeamRequestStorePort } from "@opensteer/database/team-requests-port";
import { TeamAccessStore } from "@opensteer/database/team-access";
import { TeamChatStore } from "@opensteer/database/team-chat";
import { TeamRequestsStore } from "@opensteer/database/team-requests";
import { createTeamFixture } from "@opensteer/database/test-support/team";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { createDatabase } from "@opensteer/database";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import {
  TeamAgentRequestSchema,
  TeamLinkViewSchema,
  serializeTeamLinkOffer,
  teamBinaryRoutes,
  type TeamAgentRequest,
} from "@opensteer/protocol";
import {
  teamApiVersion,
  teamApiVersionHeader,
  hostDiscoverySigningBytes,
  hostKeyFingerprint,
} from "@opensteer/deployment-authority";
import type { HarnessSession, HarnessEvent } from "@opensteer/harness";
import type { TaskAdmissionPort } from "../threads/task-admission.js";
import type { TeamAccessLockPort, TeamAccessResolver } from "../team/access-port.js";
import { TeamEndpointLinks } from "../team-link-endpoint/links.js";
import { TeamLinkLifetimes } from "../team-link-endpoint/lifetimes.js";
import { TeamLinkEndpoint } from "../team-link-endpoint/endpoint.js";
import { TeamLinkBinary } from "../team-link-endpoint/binary.js";
import { registerTeamLinkRoutes } from "../team-link-endpoint/routes.js";
import {
  linkError,
  teamLinkRoutes,
  type TeamLinkCallInput,
  type TeamMachineFilesPort,
} from "../team-link-endpoint/contracts.js";
import { PersonalTeamRequests, type PersonalTeamRunPort } from "./requests.js";
import { PersonalTeamVault } from "./vault.js";
import { TeamLinkConnection } from "./connection.js";
import { PersonalTeamLinks } from "./service.js";
import { TeamRunTools } from "./tools.js";

export async function createTwoHostLinkFixture() {
  const team = await createTeamFixture();
  const clone = await cloneTestDatabase("host");
  let connection: TeamLinkConnection | undefined;
  let personalService: PersonalTeamLinks | undefined;
  const { database, personalApp, teamApp, lifetimes } = await ownTestDatabaseProducer(
    clone.url,
    async () => {
      const database = createDatabase({ connectionString: clone.url });
      const personalApp = fastify();
      const teamApp = fastify();
      const lifetimes = new TeamLinkLifetimes();
      return {
        database,
        personalApp,
        teamApp,
        lifetimes,
        close: async () => {
          await personalService?.stop();
          connection?.stop();
          lifetimes.stop();
          await personalApp.close();
          await teamApp.close();
          await database.destroy();
        },
      };
    },
  );
  const personal = await seedPersonalFixture(database, "/tmp/PRIVATE_SENTINEL/agent-home");
  let revision = 0;
  const sourceFor = (request: TeamAgentRequest): TeamSource => ({
    teamId: team.deploymentId,
    channelId: request.channelId,
    threadRootId: request.threadRootId,
    messageId: request.triggerMessageId,
    audience: {
      teamName: "Acme",
      channelName: "support",
      channelKind: "private",
      memberCount: 2,
      peopleOnly: false,
    },
  });
  const access: TeamAccessLockPort = {
    get revision() {
      return SequenceSchema.parse(String(revision));
    },
    async mutate(write) {
      const result = await team.database.transaction().execute(async (tx) => {
        await sql`select * from team_access_state where singleton_key='team' for update`.execute(
          tx,
        );
        const result = await write(tx);
        await sql`update team_access_state set revision=revision+1 where singleton_key='team'`.execute(
          tx,
        );
        return result;
      });
      revision++;
      lifetimes.close(result.effects);
      return result.value;
    },
    async contentWrite(actor, channelId, write) {
      return team.database.transaction().execute(async (tx) => {
        await sql`select * from team_access_state where singleton_key='team' for share`.execute(tx);
        await tx
          .selectFrom("teamChannels")
          .select("id")
          .where("id", "=", channelId)
          .forNoKeyUpdate()
          .execute();
        const rights = await resolver.channel(tx, actor, channelId);
        if (!rights.post || rights.peopleOnly) throw linkError();
        return write(tx, rights);
      });
    },
    async knowledgeWrite() {
      throw new Error("Knowledge execution belongs to lane K");
    },
    async handoff(authorizedAt, authorize, deliver) {
      if (authorizedAt !== access.revision && !(await authorize())) throw linkError();
      return deliver();
    },
  };
  const channelId = createId("teamChannel");
  await sql`insert into team_channels(id,kind,name,normalized_name,created_by,people_only,instructions_markdown) values(${channelId},'private','support','support',${team.userId},false,'Original instructions')`.execute(
    team.database,
  );
  await sql`insert into team_channel_members(channel_id,subject_kind,subject_id,level,manage,added_by) values(${channelId},'person',${team.userId},'post',true,${team.userId})`.execute(
    team.database,
  );
  const resolver: TeamAccessResolver = {
    async channel(tx, actor, target) {
      const row = await tx
        .selectFrom("teamChannels")
        .selectAll()
        .where("id", "=", target)
        .executeTakeFirst();
      const member = await tx
        .selectFrom("teamMembers")
        .select("state")
        .where("userId", "=", actor.userId)
        .executeTakeFirst();
      const allowed =
        target === channelId &&
        member?.state === "active" &&
        !!row &&
        !(actor.kind === "agent" && row.peopleOnly);
      return {
        read: allowed,
        post: allowed,
        manage: allowed,
        peopleOnly: row?.peopleOnly ?? false,
      };
    },
    async topic() {
      return { read: false, write: false, manage: false, peopleOnly: false };
    },
  };
  const links = new TeamEndpointLinks(team.database, access, "Acme");
  const code = randomBytes(32).toString("base64url");
  const linkId = createId("teamLink");
  const secret = `ost_link_${randomBytes(32).toString("base64url")}`;
  const redeemInput = {
    code,
    credentialHash: createHash("sha256").update(secret).digest("hex"),
    personalDeploymentId: personal.deploymentId,
    installationLabel: "Fixture Mac",
  };
  await sql`insert into team_links(id,owner_user_id,state,code_hash,code_expires_at) values(${linkId},${team.userId},'pending',${createHash("sha256").update(code).digest("hex")},now()+interval '10 minutes')`.execute(
    team.database,
  );
  const remote = await links.redeem(redeemInput);
  const personalLinks = new PersonalTeamLinksStore(database);
  const requests = new PersonalTeamRequestsStore(database);
  const vault = new PersonalTeamVault(
    new AesGcmCredentialVault(new StaticEncryptionKeyProvider(new Map([[1, randomBytes(32)]]), 1)),
    database,
    personal.userId,
  );
  const offer = {
    origin: "https://team.example.invalid",
    teamId: team.deploymentId,
    hostKeyFingerprint: "fixture-fingerprint",
    code,
  };
  const sealed = await vault.prepare(offer);
  await personalLinks.begin(
    {
      teamDeploymentId: team.deploymentId,
      teamHostInstanceId: team.hostInstanceId,
      hostKeyFingerprint: offer.hostKeyFingerprint,
      approvedOrigin: offer.origin,
      authorityEnvelope: { teamName: "Acme" },
      credentialReference: sealed.credential.id,
      remoteLinkId: remote.id,
      remoteOwnerUserId: remote.ownerUserId,
      state: "active",
      lastContactAt: null,
    },
    sealed.credential,
  );
  const { id: principalId } = await database
    .selectFrom("principals")
    .select("id")
    .where("userId", "=", personal.userId)
    .executeTakeFirstOrThrow();
  const harnessId = createId("harnessInstance");
  await sql`insert into harness_instances(id,environment_id,driver_kind,name,config,runtime_revision,state_kind,enabled,is_default,source_id) values(${harnessId},${personal.environmentId},'codex','Scripted','{}',1,'native-user',true,true,'fixture')`.execute(
    database,
  );
  const rawView = (row: Awaited<ReturnType<typeof teamRequestRow>>): TeamAgentRequest =>
    TeamAgentRequestSchema.parse({
      id: row.id,
      ownerUserId: row.ownerUserId,
      channelId: row.channelId,
      threadRootId: row.threadRootId,
      triggerMessageId: row.triggerMessageId,
      state: row.state,
      steps: row.steps,
      createdAt: new Date(row.createdAt).toISOString(),
      acceptedAt: row.acceptedAt ? new Date(row.acceptedAt).toISOString() : null,
      expiresAt: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
      finishedAt: row.finishedAt ? new Date(row.finishedAt).toISOString() : null,
      replyMessageId: row.replyMessageId,
      failureCode: row.failureCode,
      changeSeq: row.changeSeq,
    });
  async function teamRequestRow(id: TeamAgentRequestId) {
    return team.database
      .selectFrom("teamAgentRequests")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }
  const chatAccess = new TeamAccessStore(team.database);
  await chatAccess.initialize();
  const chat = new TeamChatStore(chatAccess, { teamId: team.deploymentId, teamName: "Acme" });
  const requestStore = new TeamRequestsStore(chatAccess, chat);
  let knowledgeAllowed = true;
  let beforeKnowledgeReturn: (() => Promise<void>) | undefined;
  const endpoint = new TeamLinkEndpoint({
    links,
    requests: requestStore,
    access,
    lifetimes,
    resolver,
    data: {
      async channels(actor, currentLink, input) {
        const page = await chat.directory(actor, input.after, false, undefined, currentLink);
        return {
          channels: page.channels.map((entry) => entry.channel),
          hasMore: page.nextCursor !== null,
          nextAfter: page.nextCursor,
        };
      },
      async read(actor, currentLink, input) {
        return chat.read(
          actor,
          "read",
          input.channelId,
          async (tx) => ({
            page: await chat.pageIn(
              tx,
              actor,
              input.channelId,
              input.after
                ? { direction: "after", messageId: input.after }
                : input.before
                  ? { direction: "before", messageId: input.before }
                  : { direction: "newest" },
              input.threadRootId,
            ),
            source: await chat.source(tx, actor, input.channelId, input.threadRootId ?? null),
          }),
          currentLink,
        );
      },
      async search(actor, currentLink, input) {
        return chat.search(actor, input.input, currentLink);
      },
      async knowledge() {
        await beforeKnowledgeReturn?.();
        return {
          result: {
            kind: "knowledge.read" as const,
            result: { notes: [], topics: [], nextBefore: null, truncated: false },
          },
          reauthorize: async () => knowledgeAllowed,
        };
      },
    },
  });
  const wire: unknown[] = [];
  let offline = false;
  let loseReply = false;
  const call = async (input: TeamLinkCallInput) => {
    if (offline) throw linkError("runner_offline");
    wire.push(input);
    const result = await endpoint.call(linkId, { ...input, id: randomUUID() });
    wire.push(result);
    if (input.type === "post" && loseReply) {
      loseReply = false;
      throw linkError("runner_offline");
    }
    return result;
  };
  const admission: TaskAdmissionPort = {
    async admitTeamRequest(input) {
      return database.transaction().execute(async (tx) => {
        const key = `team:${input.origin.teamId}:${input.requestId}`;
        const existing = await tx
          .selectFrom("threadInputs")
          .selectAll()
          .where("idempotencyKey", "=", key)
          .executeTakeFirst();
        const fingerprint = `${input.requestId}:${input.triggerMessageId}`;
        if (existing) {
          if (existing.requestFingerprint !== fingerprint) throw linkError("conflict");
          return { taskId: existing.threadId, inputId: existing.messageId, runId: existing.runId };
        }
        const bound = await tx
          .selectFrom("threads")
          .select("id")
          .where("teamId", "=", input.origin.teamId)
          .where("channelId", "=", input.origin.channelId)
          .where("threadRootId", "=", input.origin.threadRootId)
          .executeTakeFirst();
        const taskId = bound?.id ?? createId("thread");
        if (!bound)
          await sql`insert into threads(id,lineage_root_thread_id,purpose,team_id,channel_id,thread_root_id,listed,title,icon_source,color,environment_id,harness_instance_id,model_selection,created_by,created_by_principal_id) values(${taskId},${taskId},'task',${input.origin.teamId},${input.origin.channelId},${input.origin.threadRootId},true,'Team task','automatic','blue',${personal.environmentId},${harnessId},'{}',${personal.userId},${principalId})`.execute(
            tx,
          );
        else
          await tx
            .updateTable("threads")
            .set({ doneAt: null, doneReason: null })
            .where("id", "=", taskId)
            .execute();
        const inputId = createId("message");
        const chainId = createId("causalChain");
        await sql`insert into causal_chains(id,max_delegations,max_autonomous_runs,used_delegations,used_autonomous_runs) values(${chainId},10,10,0,0)`.execute(
          tx,
        );
        const seq = await tx
          .updateTable("threads")
          .set({ nextMessageSequence: sql`next_message_sequence+1` })
          .where("id", "=", taskId)
          .returning("nextMessageSequence")
          .executeTakeFirstOrThrow();
        await sql`insert into messages(id,thread_id,sequence,kind,actor_principal_id,author,content) values(${inputId},${taskId},${seq.nextMessageSequence},'input',${principalId},'{}','[]')`.execute(
          tx,
        );
        await sql`insert into thread_inputs(message_id,thread_id,team_request_id,team_source,actor_principal_id,authority_source,causal_chain_id,idempotency_key,policy,queue_rank,request_fingerprint,requested_by,state) values(${inputId},${taskId},${input.requestId},${JSON.stringify(input.source)},${principalId},'{}',${chainId},${key},'queue',${seq.nextMessageSequence},${fingerprint},${personal.userId},'pending')`.execute(
          tx,
        );
        return { taskId, inputId, runId: null };
      });
    },
    async cancelTeamRequest(input) {
      const local = await requests.get(input.teamId, input.requestId);
      if (!local) return;
      if (local.runId)
        await database
          .updateTable("runs")
          .set({ status: "interrupted" })
          .where("id", "=", local.runId)
          .execute();
      else
        await database
          .updateTable("threadInputs")
          .set({ state: "cancelled" })
          .where("teamRequestId", "=", input.requestId)
          .execute();
    },
  };
  const runPort: PersonalTeamRunPort = {
    async outcome(request) {
      const input = await database
        .selectFrom("threadInputs")
        .selectAll()
        .where("teamRequestId", "=", request.requestId)
        .executeTakeFirstOrThrow();
      if (!input.runId)
        return {
          runId: null,
          state: input.state === "cancelled" ? "cancelled" : "pending",
          finalMessage: null,
          answerMessageId: null,
        };
      const run = await database
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", input.runId)
        .executeTakeFirstOrThrow();
      const message = await database
        .selectFrom("messages")
        .select(["id", "content"])
        .where("runId", "=", run.id)
        .where("kind", "=", "assistant")
        .orderBy("sequence", "desc")
        .executeTakeFirst();
      const text = (message?.content[0] as { text?: string } | undefined)?.text ?? null;
      return {
        runId: run.id,
        state:
          run.status === "completed"
            ? "done"
            : run.status === "failed"
              ? "failed"
              : run.status === "interrupted"
                ? "stopped"
                : "working",
        finalMessage: text,
        answerMessageId: message?.id ?? null,
      };
    },
  };
  const publisher = new PersonalTeamRequests({
    links: personalLinks,
    requests,
    admission,
    runs: runPort,
    rpc: () => ({ call }),
  });
  const file = {
    id: createId("teamBlob"),
    channelId,
    filename: "public.txt",
    mediaType: "text/plain",
    sizeBytes: 5,
    sha256: createHash("sha256").update("hello").digest("hex"),
    preview: null,
  };
  let stream: Readable | undefined;
  let fileSourceChannel = channelId;
  async function fileSource(
    input:
      Parameters<TeamMachineFilesPort["open"]>[0] | Parameters<TeamMachineFilesPort["upload"]>[0],
  ) {
    await links.assertActive(input.linkId);
    if (input.requestId) {
      const request = await team.database
        .selectFrom("teamAgentRequests")
        .selectAll()
        .where("id", "=", input.requestId)
        .where("linkId", "=", input.linkId)
        .executeTakeFirst();
      if (!request) throw linkError();
      return sourceFor(rawView(request));
    }
    return team.database
      .transaction()
      .execute((tx) => chat.source(tx, input.actor, channelId, null));
  }
  const files: TeamMachineFilesPort = {
    async open(input) {
      const source = await fileSource(input);
      return {
        file: { ...file, channelId: fileSourceChannel },
        source: { ...source, channelId: fileSourceChannel },
        bytes: stream ?? Readable.from([Buffer.from("hello")]),
      };
    },
    async upload(input) {
      const source = await fileSource(input);
      const chunks: Buffer[] = [];
      for await (const part of input.parts) {
        for await (const chunk of part.bytes)
          if (part.name === "original") chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks).toString();
      if (body !== "hello") throw linkError("bad_request");
      return { file, source };
    },
  };
  const binary = new TeamLinkBinary(endpoint, files, resolver);
  await teamApp.register(websocket);
  await registerTeamLinkRoutes(teamApp, endpoint, binary);
  const teamAddress = await teamApp.listen({ host: "127.0.0.1", port: 0 });
  personalApp.post("/deliver", async (request) => {
    const input = TeamAgentRequestSchema.parse(request.body);
    await publisher.deliver(team.deploymentId, {
      request: input,
      source: sourceFor(input),
      bodyMarkdown: "Team ask",
      attachments: [],
    });
    return { accepted: true };
  });
  await personalApp.listen({ host: "127.0.0.1", port: 0 });
  const startedContexts: Awaited<ReturnType<TeamRequestStorePort["context"]>>[] = [];
  let runCount = 0;
  async function local(request: TeamAgentRequest) {
    const row = await requests.get(team.deploymentId, request.id);
    if (!row) throw new Error("Missing local request");
    return row;
  }
  async function finish(
    request: TeamAgentRequest,
    text: string | null,
    state: "done" | "failed" | "stopped" | "working" = "done",
  ) {
    const saved = await local(request);
    const run = await database
      .selectFrom("threadInputs")
      .select("runId")
      .where("teamRequestId", "=", request.id)
      .executeTakeFirstOrThrow();
    if (text !== null) {
      const messageId = createId("message");
      const seq = await database
        .updateTable("threads")
        .set({ nextMessageSequence: sql`next_message_sequence+1` })
        .where("id", "=", saved.taskId)
        .returning("nextMessageSequence")
        .executeTakeFirstOrThrow();
      await sql`insert into messages(id,thread_id,run_id,sequence,kind,actor_principal_id,author,content) values(${messageId},${saved.taskId},${run.runId},${seq.nextMessageSequence},'assistant',${principalId},'{}',${JSON.stringify([{ type: "text", text }])})`.execute(
        database,
      );
    }
    await database
      .updateTable("runs")
      .set({
        status:
          state === "done"
            ? "completed"
            : state === "stopped"
              ? "interrupted"
              : state === "working"
                ? "running"
                : "failed",
      })
      .where("id", "=", run.runId!)
      .execute();
    await publisher.reconcileOne(saved);
  }
  return {
    team,
    personal,
    channelId,
    linkId,
    secret,
    links,
    startedContexts,
    get runCount() {
      return runCount;
    },
    get offline() {
      return offline;
    },
    set offline(value: boolean) {
      offline = value;
    },
    async ask(root?: TeamMessageId) {
      const message = await sql<{
        id: TeamMessageId;
      }>`insert into team_messages(channel_id,thread_root_id,author_user_id,author_kind,client_message_id,body_markdown,plain_text,change_seq) values(${channelId},${root ?? null},${team.userId},'human',${randomUUID()},'Question','Question',1) returning id`.execute(
        team.database,
      );
      const trigger = message.rows[0]!.id;
      const requestId = createId("teamAgentRequest");
      await sql`insert into team_agent_requests(id,owner_user_id,channel_id,thread_root_id,trigger_message_id,link_id,state,steps,change_seq) values(${requestId},${team.userId},${channelId},${root ?? trigger},${trigger},${linkId},'queued','[]',1)`.execute(
        team.database,
      );
      return rawView(await teamRequestRow(requestId));
    },
    async deliver(request: TeamAgentRequest) {
      const response = await personalApp.inject({
        method: "POST",
        url: "/deliver",
        payload: request,
      });
      if (response.statusCode !== 200) throw new Error(response.body);
    },
    local,
    teamRequest: async (id: TeamAgentRequestId) => rawView(await teamRequestRow(id)),
    inputCount: async () =>
      (await database.selectFrom("threadInputs").selectAll().execute()).length,
    async editContext(instructions: string, text: string) {
      await team.database
        .updateTable("teamChannels")
        .set({ instructionsMarkdown: instructions })
        .where("id", "=", channelId)
        .execute();
      await team.database
        .updateTable("teamMessages")
        .set({ bodyMarkdown: text, plainText: text })
        .where("channelId", "=", channelId)
        .execute();
    },
    async run(
      request: TeamAgentRequest,
      text: string | null,
      state: "done" | "failed" | "stopped" | "working" = "done",
    ) {
      const saved = await local(request);
      const input = await database
        .selectFrom("threadInputs")
        .selectAll()
        .where("teamRequestId", "=", request.id)
        .executeTakeFirstOrThrow();
      const runId = createId("run");
      runCount++;
      startedContexts.push(await requestStore.context(linkId, request.id));
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,access_mode,activation_input_id,causal_chain_id,model_selection,requested_by,actor_principal_id,authority_source,run_ordinal,seed_input_id,status,reply_target) values(${runId},${saved.taskId},${personal.environmentId},${harnessId},'full-access',${input.messageId},${input.causalChainId},'{}',${personal.userId},${principalId},'{}',${runCount},${input.messageId},'running',${JSON.stringify({ kind: "team-thread", teamId: team.deploymentId, channelId: request.channelId, threadRootId: request.threadRootId, requestId: request.id })}::jsonb)`.execute(
        database,
      );
      await database
        .updateTable("threadInputs")
        .set({ runId, state: "delivered" })
        .where("teamRequestId", "=", request.id)
        .execute();
      const script = new LinkScriptedSession();
      await script.execute();
      for await (const _event of script.events) {
        /* Runner event seam; P owns final-message persistence. */
      }
      await finish(request, text, state);
    },
    finish,
    reconnect: () => publisher.reconnect(team.deploymentId),
    async cancelOnTeam(request: TeamAgentRequest) {
      await requestStore.cancel(linkId, request.id);
    },
    async inputState(request: TeamAgentRequest) {
      return (
        await database
          .selectFrom("threadInputs")
          .select("state")
          .where("teamRequestId", "=", request.id)
          .executeTakeFirstOrThrow()
      ).state;
    },
    loseReplyAcknowledgement() {
      loseReply = true;
    },
    async replyCount(id: TeamAgentRequestId) {
      return (
        await team.database
          .selectFrom("teamMessages")
          .select("id")
          .where("agentRequestId", "=", id)
          .execute()
      ).length;
    },
    async privateAnswer(id: TeamAgentRequestId) {
      const saved = await requests.get(team.deploymentId, id);
      return saved ? (await runPort.outcome(saved)).finalMessage : null;
    },
    wire: () => JSON.stringify(wire),
    call,
    async cut(action: "revoke" | "remove") {
      if (action === "revoke") await links.revoke(linkId);
      else
        await access.mutate(async (tx) => {
          await tx
            .updateTable("teamMembers")
            .set({ state: "removed" })
            .where("userId", "=", team.userId)
            .execute();
          await tx
            .updateTable("teamLinks")
            .set({ state: "revoked", revokedAt: new Date().toISOString() })
            .where("id", "=", linkId)
            .execute();
          await tx
            .updateTable("teamAgentRequests")
            .set({ state: "cancelled", finishedAt: new Date().toISOString() })
            .where("linkId", "=", linkId)
            .where("finishedAt", "is", null)
            .execute();
          return {
            value: undefined,
            effects: {
              users: [team.userId],
              channels: [],
              topics: [],
              links: [linkId],
              requests: [],
            },
          };
        });
    },
    redeemAgain: (hash = redeemInput.credentialHash) =>
      links.redeem({ ...redeemInput, credentialHash: hash }),
    async replaceLink() {
      const newCode = randomBytes(32).toString("base64url");
      const newId = createId("teamLink");
      await sql`insert into team_links(id,owner_user_id,state,code_hash,code_expires_at) values(${newId},${team.userId},'pending',${createHash("sha256").update(newCode).digest("hex")},now()+interval '10 minutes')`.execute(
        team.database,
      );
      return links.redeem({ ...redeemInput, code: newCode, credentialHash: "b".repeat(64) });
    },
    async connect() {
      connection = new TeamLinkConnection({
        teamId: team.deploymentId,
        open: async () => {
          const socket = new WebSocket(
            teamAddress.replace("http:", "ws:") + teamLinkRoutes.socket,
            {
              headers: {
                authorization: `Bearer ${secret}`,
                [teamApiVersionHeader]: String(teamApiVersion),
              },
            },
          );
          await once(socket, "open");
          return socket;
        },
        terminalRequests: () => requests.forTeam(team.deploymentId),
        onReady: () => publisher.reconnect(team.deploymentId),
        onState: async () => undefined,
        onFrame: async (frame) => {
          if (frame.type === "requests")
            for (const item of frame.requests) await publisher.deliver(team.deploymentId, item);
          else if (frame.type === "cancel")
            await publisher.cancel(team.deploymentId, frame.requestId);
          else await publisher.revoked(team.deploymentId);
        },
      });
      connection.start();
    },
    async disconnect() {
      connection?.stop();
      connection = undefined;
    },
    async waitForInput(id: TeamAgentRequestId) {
      await vi.waitFor(
        async () => {
          expect(
            await requests.get(team.deploymentId, id),
            "outbound socket never admitted request",
          ).not.toBeNull();
        },
        { timeout: 3000 },
      );
    },
    async knowledgeFence(request: TeamAgentRequest) {
      let prepared!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeKnowledgeReturn = async () => {
        prepared();
        await barrier;
      };
      const result = call({
        type: "knowledge.read",
        requestId: request.id,
        input: { query: "pricing" },
      });
      const refused = expect(result).rejects.toMatchObject({ code: "forbidden" });
      try {
        await withTimeout(started, 2000, {
          timeoutError: () =>
            new Error("The knowledge read did not reach the buffered-result barrier"),
        });
        await access.mutate(async () => {
          knowledgeAllowed = false;
          return {
            value: undefined,
            effects: { users: [], channels: [], topics: [], links: [], requests: [] },
          };
        });
      } finally {
        release();
      }
      await refused;
    },
    async authorityMatrix(request: TeamAgentRequest) {
      const input = await database
        .selectFrom("threadInputs")
        .select(["runId", "threadId"])
        .where("teamRequestId", "=", request.id)
        .executeTakeFirstOrThrow();
      const runId = input.runId!;
      const privateRun = createId("run");
      await sql`insert into runs(id,thread_id,environment_id,harness_instance_id,access_mode,activation_input_id,causal_chain_id,model_selection,requested_by,actor_principal_id,authority_source,run_ordinal,seed_input_id,status,reply_target) select ${privateRun},thread_id,environment_id,harness_instance_id,access_mode,activation_input_id,causal_chain_id,model_selection,requested_by,actor_principal_id,authority_source,99,seed_input_id,'queued',null from runs where id=${runId}`.execute(
        database,
      );
      const tools = new TeamRunTools(personalLinks, requests, () => ({ call }));
      expect((await tools.context(runId)).source.audience.teamName).toBe("Acme");
      await expect(tools.context(privateRun)).rejects.toMatchObject({ code: "forbidden" });
      const standing = { runId: privateRun, operationId: "standing" };
      expect(
        (await tools.channels(standing, team.deploymentId)).channels.map((channel) => channel.id),
      ).toContain(request.channelId);
      expect(
        (
          await tools.read(standing, team.deploymentId, {
            channelId: request.channelId,
            threadRootId: request.threadRootId,
          })
        ).page.messages.map((message) => message.id),
      ).toContain(request.triggerMessageId);
      expect(
        (
          await tools.search(standing, team.deploymentId, {
            channelId: request.channelId,
            query: "Question",
          })
        ).results.map((result) => result.message.id),
      ).toContain(request.triggerMessageId);
      await tools.post(standing, team.deploymentId, {
        channelId: request.channelId,
        threadRootId: request.threadRootId,
        bodyMarkdown: "A private turn's explicit post",
        attachmentIds: [],
      });
      expect(await requestStore.receipt(linkId, request.id)).toBeNull();
      await tools.post({ runId, operationId: "explicit" }, team.deploymentId, {
        channelId: request.channelId,
        threadRootId: request.threadRootId,
        bodyMarkdown: "Explicit team reply",
        attachmentIds: [],
      });
      await finish(request, "Private final fallback");
      const messages = await team.database
        .selectFrom("teamMessages")
        .select("bodyMarkdown")
        .where("agentRequestId", "=", request.id)
        .execute();
      expect(messages).toEqual([{ bodyMarkdown: "Explicit team reply" }]);
    },
    async safeProgress(request: TeamAgentRequest) {
      const progress = {
        state: "working" as const,
        steps: [
          {
            kind: "read_files",
            count: 2,
            path: "/private/PRIVATE_SENTINEL",
            payload: "PRIVATE_TRANSCRIPT",
          },
        ],
      };
      await publisher.status(team.deploymentId, request.id, progress);
      await publisher.status(team.deploymentId, request.id, progress);
      await publisher.status(team.deploymentId, request.id, {
        state: "needs_you",
        steps: progress.steps,
      });
      const statuses = wire.filter(
        (value) =>
          typeof value === "object" && value !== null && "type" in value && value.type === "status",
      );
      expect(statuses).toHaveLength(2);
      expect(JSON.stringify(statuses)).not.toMatch(/PRIVATE_SENTINEL|PRIVATE_TRANSCRIPT/);
    },
    async joinRoundTrip() {
      await database
        .deleteFrom("personalTeamLinks")
        .where("teamDeploymentId", "=", team.deploymentId)
        .execute();
      const keys = generateKeyPairSync("ed25519");
      const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
      const document = {
        canonicalOrigin: offer.origin,
        deploymentId: team.deploymentId,
        hostInstanceId: team.hostInstanceId,
        deploymentShape: { kind: "team" as const },
        hostKey: { algorithm: "Ed25519" as const },
      };
      const authority = {
        document,
        publicKey: { algorithm: "Ed25519", spki },
        signature: sign(null, hostDiscoverySigningBytes(document), keys.privateKey).toString(
          "base64url",
        ),
      };
      const descriptor = {
        kind: "team",
        apiVersion: teamApiVersion,
        authority,
        bootstrapMethods: [],
        capabilities: [],
      };
      const newCode = randomBytes(32).toString("base64url");
      const newLink = createId("teamLink");
      await sql`insert into team_links(id,owner_user_id,state,code_hash,code_expires_at) values(${newLink},${team.userId},'pending',${createHash("sha256").update(newCode).digest("hex")},now()+interval '10 minutes')`.execute(
        team.database,
      );
      const text = serializeTeamLinkOffer({
        ...offer,
        code: newCode,
        hostKeyFingerprint: hostKeyFingerprint(spki),
      });
      let lost = true;
      let disconnected = false;
      const frames: { type: string }[] = [];
      teamApp.websocketServer.on("connection", (socket) =>
        socket.on("message", (raw) => {
          frames.push(JSON.parse(raw.toString()));
        }),
      );
      personalService = new PersonalTeamLinks({
        deploymentId: personal.deploymentId,
        installationLabel: "Fixture Mac",
        links: personalLinks,
        vault,
        requests: publisher,
        network: {
          async discover() {
            return descriptor;
          },
          async redeem(_origin, input) {
            const response = await teamApp.inject({
              method: "POST",
              url: teamLinkRoutes.redeem,
              headers: { [teamApiVersionHeader]: String(teamApiVersion) },
              payload: input,
            });
            expect(response.statusCode).toBe(200);
            if (lost) {
              lost = false;
              throw linkError("runner_offline");
            }
            return TeamLinkViewSchema.parse(response.json());
          },
          async connect(_origin, token) {
            if (disconnected) throw linkError("runner_offline");
            const socket = new WebSocket(
              teamAddress.replace("http:", "ws:") + teamLinkRoutes.socket,
              {
                headers: {
                  authorization: `Bearer ${token}`,
                  [teamApiVersionHeader]: String(teamApiVersion),
                },
              },
            );
            await once(socket, "open");
            return socket;
          },
        },
      });
      await expect(personalService.join(text)).rejects.toMatchObject({ code: "runner_offline" });
      expect((await personalLinks.get(team.deploymentId))?.state).toBe("joining");
      const joined = await personalService.join(text);
      expect(joined.remoteLinkId).toBe(newLink);
      const stored = (await personalLinks.get(team.deploymentId))!;
      const secrets = await vault.open(stored.credentialReference!, team.deploymentId);
      expect(secrets.secret).toMatch(/^ost_link_[A-Za-z0-9_-]{43}$/);
      const remote = await links.authenticate(secrets.secret);
      expect(remote.id).toBe(newLink);
      const credential = await database
        .selectFrom("credentials")
        .select("encryptedPayload")
        .where("id", "=", sealed.credential.id)
        .executeTakeFirstOrThrow();
      expect(credential.encryptedPayload.toString()).not.toContain("ost_link_");
      expect(JSON.stringify(joined)).not.toMatch(/ost_link_|credentialReference|code/);
      await vi.waitFor(
        () => {
          expect(
            frames.some((frame) => frame.type === "hello"),
            "join socket never sent hello",
          ).toBe(true);
        },
        { timeout: 3000 },
      );
      disconnected = true;
      const offset = frames.length;
      await personalService.leave(team.deploymentId);
      expect((await personalLinks.get(team.deploymentId))?.state).toBe("leaving");
      expect(() => personalService!.rpc(team.deploymentId)).toThrow();
      disconnected = false;
      await vi.waitFor(
        async () => {
          expect(
            (await personalLinks.get(team.deploymentId))?.state,
            "queued revoke did not complete",
          ).toBe("revoked");
        },
        { timeout: 3000 },
      );
      expect(
        frames.slice(offset).every((frame) => ["hello", "revoke", "ping"].includes(frame.type)),
      ).toBe(true);
    },
    async binaryMatrix(request: TeamAgentRequest, removal: "revoke" | "remove" = "revoke") {
      const base = {
        [teamApiVersionHeader]: String(teamApiVersion),
        "x-opensteer-team-run-id": createId("run"),
        "x-opensteer-team-operation-id": "file-operation",
        "x-opensteer-team-blob-id": file.id,
        "x-opensteer-team-file-part": "original",
      };
      for (const credential of [
        undefined,
        "Bearer ost_mcp_wrong",
        "Bearer ost_run_wrong",
        "Bearer app-session",
        "Bearer ost_link_" + "z".repeat(43),
      ]) {
        const result = await teamApp.inject({
          method: "GET",
          url: teamBinaryRoutes.download,
          headers: {
            ...base,
            ...(credential ? { authorization: credential } : { cookie: "session=human" }),
          },
        });
        expect(result.statusCode).toBe(401);
      }
      const correct = { ...base, authorization: `Bearer ${secret}` };
      const result = await teamApp.inject({
        method: "GET",
        url: teamBinaryRoutes.download,
        headers: correct,
      });
      expect(result.statusCode).toBe(200);
      expect(result.body).toBe("hello");
      const wrongVersion = await teamApp.inject({
        method: "GET",
        url: teamBinaryRoutes.download,
        headers: { ...correct, [teamApiVersionHeader]: "0", authorization: "invalid" },
      });
      expect(wrongVersion.statusCode).toBe(426);
      const wrongRequest = await teamApp.inject({
        method: "GET",
        url: teamBinaryRoutes.download,
        headers: { ...correct, "x-opensteer-team-request-id": createId("teamAgentRequest") },
      });
      expect(wrongRequest.statusCode).toBe(403);
      fileSourceChannel = createId("teamChannel");
      await sql`insert into team_channels(id,kind,name,normalized_name,created_by,people_only,instructions_markdown) values(${fileSourceChannel},'private','restricted','restricted',${team.userId},false,'')`.execute(
        team.database,
      );
      const wrongChannel = await teamApp.inject({
        method: "GET",
        url: teamBinaryRoutes.download,
        headers: correct,
      });
      expect(wrongChannel.statusCode).toBe(403);
      fileSourceChannel = channelId;
      const boundary = "fixture";
      const upload = await teamApp.inject({
        method: "POST",
        url: teamBinaryRoutes.upload,
        headers: {
          authorization: correct.authorization,
          [teamApiVersionHeader]: base[teamApiVersionHeader],
          "x-opensteer-team-run-id": createId("run"),
          "x-opensteer-team-operation-id": "file-operation",
          "content-type": `multipart/form-data; boundary=${boundary}`,
          "x-opensteer-team-upload": JSON.stringify({
            channelId: request.channelId,
            clientUploadId: randomUUID(),
            filename: "public.txt",
            mediaType: "text/plain",
            sizeBytes: 5,
            sha256: file.sha256,
            previewSizeBytes: 0,
          }),
        },
        payload: `--${boundary}\r\nContent-Disposition: form-data; name="original"; filename="public.txt"\r\n\r\nhello\r\n--${boundary}--\r\n`,
      });
      expect(upload.statusCode).toBe(200);
      const tooLarge = await teamApp.inject({
        method: "POST",
        url: teamBinaryRoutes.upload,
        headers: {
          authorization: correct.authorization,
          [teamApiVersionHeader]: base[teamApiVersionHeader],
          "x-opensteer-team-request-id": request.id,
          "x-opensteer-team-run-id": createId("run"),
          "x-opensteer-team-operation-id": "file-operation",
          "content-type": "multipart/form-data; boundary=fixture",
          "x-opensteer-team-upload": JSON.stringify({
            channelId: request.channelId,
            clientUploadId: randomUUID(),
            filename: "x",
            mediaType: "text/plain",
            sizeBytes: 100 * 1024 * 1024 + 1,
            sha256: file.sha256,
            previewSizeBytes: 0,
          }),
        },
        payload: "",
      });
      expect(tooLarge.statusCode).toBe(403);
      const wrongBlob = await teamApp.inject({
        method: "GET",
        url: teamBinaryRoutes.download,
        headers: { ...correct, "x-opensteer-team-blob-id": createId("teamBlob") },
      });
      expect(wrongBlob.statusCode).toBe(403);
      stream = new PassThrough();
      const peopleOnlyStream = await binary.download(correct, new AbortController().signal);
      const reading = (async () => {
        for await (const _chunk of peopleOnlyStream.bytes) {
          /* await channel revocation */
        }
      })();
      const cancelled = expect(reading).rejects.toBeDefined();
      await access.mutate(async (tx) => {
        await tx
          .updateTable("teamChannels")
          .set({ peopleOnly: true })
          .where("id", "=", channelId)
          .execute();
        return {
          value: undefined,
          effects: { users: [], channels: [channelId], topics: [], links: [], requests: [] },
        };
      });
      await cancelled;
      const peopleOnly = await teamApp.inject({
        method: "GET",
        url: teamBinaryRoutes.download,
        headers: correct,
      });
      expect(peopleOnly.statusCode).toBe(403);
      await team.database
        .updateTable("teamChannels")
        .set({ peopleOnly: false })
        .where("id", "=", channelId)
        .execute();
      stream = new PassThrough();
      const opened = await binary.download(correct, new AbortController().signal);
      const consumed = (async () => {
        for await (const _chunk of opened.bytes) {
          /* consume until revoked */
        }
      })();
      const denied = expect(consumed).rejects.toBeDefined();
      await this.cut(removal);
      await denied;
      expect(stream.destroyed).toBe(true);
    },
    async close() {
      await personalService?.stop();
      connection?.stop();
      lifetimes.stop();
      await personalApp.close();
      await teamApp.close();
      await database.destroy();
      await clone.drop();
      await team.close();
    },
  };
}

class LinkScriptedSession implements HarnessSession {
  readonly providerSessionReference = "scripted-team-link";
  readonly events: AsyncIterable<HarnessEvent> = (async function* () {
    yield { type: "run.started", data: { status: "running" } } as const;
    yield { type: "run.completed", data: { status: "completed" } } as const;
  })();
  async execute(): Promise<void> {}
  async interrupt(): Promise<void> {}
  async resolveRequest(): Promise<void> {}
  async stop(): Promise<void> {}
}
