import type { HostApiClient } from "@opensteer/protocol";
import { unwrapRpcResult } from "./host-session-client.js";
import type { HostClient } from "./client.js";
import { compareSequence } from "@opensteer/core";
import { DeploymentIdSchema, TeamChannelIdSchema, TeamMessageIdSchema } from "@opensteer/core";
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

/** Reads only the local publication corresponding to the reply the person saw. */
export async function readTeamReply(
  client: Pick<HostClient, "getSnapshot" | "markThreadRead" | "rpc">,
  origin: {
    readonly teamId: string;
    readonly channelId: string;
    readonly threadRootId: string;
    readonly replyMessageId: string;
  },
  visible: () => boolean = () => true,
): Promise<boolean> {
  const publication = unwrapRpcResult(
    await client.rpc["teams.replyTask.get"]({
      teamId: DeploymentIdSchema.parse(origin.teamId),
      channelId: TeamChannelIdSchema.parse(origin.channelId),
      threadRootId: TeamMessageIdSchema.parse(origin.threadRootId),
      replyMessageId: TeamMessageIdSchema.parse(origin.replyMessageId),
    }),
  );
  if (!visible()) return false;
  if (!publication.taskId || !publication.throughSequence) return false;
  const state = client.getSnapshot().threadReadStates[publication.taskId];
  if (!state || compareSequence(state.asOfSequence, publication.throughSequence) < 0) return false;
  if (state.readSequence && compareSequence(state.readSequence, publication.throughSequence) >= 0)
    return true;
  await client.markThreadRead(publication.taskId, publication.throughSequence);
  return true;
}

/** Keeps an unresolved visible reply waiting on personal read-state notices, without polling. */
export function watchTeamReplyRead(
  client: Pick<HostClient, "getSnapshot" | "markThreadRead" | "rpc" | "subscribe">,
  origin: Parameters<typeof readTeamReply>[1],
): () => void {
  let active = true;
  let reading = false;
  let again = false;
  let states = client.getSnapshot().threadReadStates;
  let unsubscribe: () => void = () => undefined;
  const stop = () => {
    active = false;
    unsubscribe();
  };
  const read = () => {
    if (!active) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    again = false;
    void readTeamReply(client, origin, () => active)
      .then(
        (done) => {
          if (done) stop();
        },
        () => undefined,
      )
      .finally(() => {
        reading = false;
        if (again) read();
      });
  };
  unsubscribe = client.subscribe(() => {
    const next = client.getSnapshot().threadReadStates;
    if (states === next) return;
    states = next;
    read();
  });
  read();
  return stop;
}
