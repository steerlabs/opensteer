import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import {
  createId,
  type UserId,
  type TeamLinkId,
  type DeploymentId,
  type HostInstanceId,
} from "@opensteer/core";
import { createDatabase, OpensteerStore, type DatabaseSchema } from "@opensteer/database";
import type { Kysely } from "kysely";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import {
  createPersonalRunFixturePort,
  startPersonalQueuedRunFixture,
} from "@opensteer/database/test-support/personal-run";
import { pendingEvent } from "@opensteer/database/test-support/store";
import { PersonalTeamLinksStore } from "@opensteer/database/personal-team-links-store";
import { PersonalTeamRequestsStore } from "@opensteer/database/personal-team-requests-store";
import { personalTeamRunOutcome } from "@opensteer/database/personal-team-run-store";
import { TeamLinkResultSchema, TeamRunRequestSchema } from "@opensteer/protocol";
import type { startTeamServices } from "../team/services.js";
import type { TeamLinkEndpoint } from "../team-link-endpoint/endpoint.js";
import type { TeamLinkCallInput } from "../team-link-endpoint/contracts.js";
import { TaskAdmissionService } from "../threads/task-admission-service.js";
import { PersonalTeamRequests } from "./requests.js";
import { TeamRunTools } from "./tools.js";

export async function linkedPersonalHost(
  team: {
    database: Kysely<DatabaseSchema>;
    deploymentId: DeploymentId;
    hostInstanceId: HostInstanceId;
    team: Pick<Awaited<ReturnType<typeof startTeamServices>>, "requests">;
    machine: { endpoint: Pick<TeamLinkEndpoint, "call"> };
  },
  teamUserId: UserId,
  linkId: TeamLinkId,
) {
  const clone = await cloneTestDatabase("host");
  try {
    const { database } = await ownTestDatabaseProducer(clone.url, async () => {
      const database = createDatabase({ connectionString: clone.url });
      return { database, close: () => database.destroy() };
    });
    const owner = await seedPersonalFixture(database, tmpdir());
    await team.database
      .updateTable("teamLinks")
      .set({ personalDeploymentId: owner.deploymentId })
      .where("id", "=", linkId)
      .execute();
    const store = new OpensteerStore(database);
    const runs = createPersonalRunFixturePort(store);
    const task = await runs.createTask({ ownerId: owner.userId, suffix: "asking-peer" });
    const execution = {
      environmentId: owner.environmentId,
      harnessInstanceId: task.harnessInstance.id,
      modelSelection: task.thread.modelSelection,
    };
    const links = new PersonalTeamLinksStore(database);
    await database
      .insertInto("personalTeamLinks")
      .values({
        id: randomUUID(),
        teamDeploymentId: team.deploymentId,
        teamHostInstanceId: team.hostInstanceId,
        hostKeyFingerprint: "fixture",
        approvedOrigin: "https://team.example.invalid",
        authorityEnvelope: { teamName: "Acme" },
        state: "active",
        remoteOwnerUserId: teamUserId,
        remoteLinkId: linkId,
      })
      .execute();
    const requests = new PersonalTeamRequestsStore(database);
    const rpc = () => ({
      call: async (input: TeamLinkCallInput) =>
        TeamLinkResultSchema.parse(
          await team.machine.endpoint.call(linkId, { ...input, id: randomUUID() }),
        ),
    });
    const publisher = new PersonalTeamRequests({
      links,
      requests,
      rpc,
      admission: new TaskAdmissionService({
        database,
        execution: async () => execution,
        publish() {},
        revokeGrants() {},
      }),
      runs: { outcome: (request) => personalTeamRunOutcome(database, request) },
    });
    const tools = new TeamRunTools(links, requests, rpc);
    const deliver = async () => {
      for (const frame of await team.team.requests.pending(linkId))
        await publisher.deliver(team.deploymentId, TeamRunRequestSchema.parse(frame));
    };
    const answer = async (
      requestId: import("@opensteer/core").TeamAgentRequestId,
      text: string,
    ) => {
      const request = (await requests.get(team.deploymentId, requestId))!;
      const started = await startPersonalQueuedRunFixture(store, request.runId!);
      const scope = {
        runId: started.run.id,
        threadId: started.run.threadId,
        environmentId: owner.environmentId,
        bindingGeneration: started.bindingGeneration,
      };
      for (const event of [
        pendingEvent({
          ...scope,
          type: "assistant.message",
          ordinal: 1,
          data: { messageId: createId("message"), content: [{ type: "text", text }] },
        }),
        pendingEvent({
          ...scope,
          type: "run.completed",
          ordinal: 2,
          data: { status: "completed" },
        }),
      ])
        await store.commitRunnerEvent({
          environmentId: owner.environmentId,
          runnerId: owner.runnerId,
          runnerBootId: started.runnerBootId,
          event,
        });
      await publisher.reconcileOne(request);
    };
    return {
      database,
      owner,
      requests,
      publisher,
      tools,
      runs,
      task,
      deliver,
      answer,
      close: async () => {
        await publisher.stop();
        await clone.drop();
      },
    };
  } catch (error) {
    await clone.drop();
    throw error;
  }
}
