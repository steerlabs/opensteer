import type { HostApiClient } from "@opensteer/protocol";
import { unwrapRpcResult } from "./host-session-client.js";
import type { HostClient } from "./client.js";
import { isThreadUnread } from "./thread-read-state.js";
import {
  DeploymentIdSchema,
  TeamChannelIdSchema,
  TeamMessageIdSchema,
  type TaskFolder,
} from "@opensteer/core";
export class PersonalTeamLinks {
  readonly rpc: HostApiClient;
  constructor(rpc: HostApiClient) {
    this.rpc = rpc;
  }
  async list() {
    return unwrapRpcResult(await this.rpc["teams.links.list"]({})).links;
  }
  async join(link: string) {
    const result = unwrapRpcResult(
      await this.rpc["commands.dispatch"]({ type: "teams.link.join", link }),
    );
    if (result.type !== "teams.link.join") throw new Error("Team link result mismatch.");
    return result.link;
  }
  async leave(teamId: string): Promise<void> {
    unwrapRpcResult(await this.rpc["commands.dispatch"]({ type: "teams.link.leave", teamId }));
  }
  async folder(teamId: string, channelId: string): Promise<TaskFolder> {
    return unwrapRpcResult(await this.rpc["teams.channelFolder.get"]({ teamId, channelId })).folder;
  }
  async setFolder(teamId: string, channelId: string, folder: TaskFolder): Promise<void> {
    unwrapRpcResult(
      await this.rpc["commands.dispatch"]({
        type: "teams.channelFolder.set",
        teamId,
        channelId,
        folder,
      }),
    );
  }
  async task(teamId: string, channelId: string, threadRootId: string) {
    return unwrapRpcResult(
      await this.rpc["teams.threadTask.get"]({
        teamId: DeploymentIdSchema.parse(teamId),
        channelId: TeamChannelIdSchema.parse(channelId),
        threadRootId: TeamMessageIdSchema.parse(threadRootId),
      }),
    ).taskId;
  }
}

/**
 * Reading your agent's reply in its team thread reads its task: the local
 * task bound to that thread is marked read through what it last published.
 */
export async function readTeamReply(
  client: Pick<HostClient, "getSnapshot" | "markThreadRead" | "rpc">,
  origin: { readonly teamId: string; readonly channelId: string; readonly threadRootId: string },
): Promise<void> {
  const taskId = await new PersonalTeamLinks(client.rpc).task(
    origin.teamId,
    origin.channelId,
    origin.threadRootId,
  );
  if (!taskId) return;
  const state = client.getSnapshot().threadReadStates[taskId];
  if (!state?.unreadSequence || !isThreadUnread(state)) return;
  await client.markThreadRead(taskId, state.unreadSequence);
}
