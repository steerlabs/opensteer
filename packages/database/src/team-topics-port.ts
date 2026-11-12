import type { KnowledgeTopicId, TeamChannelId, UserId } from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "./schema.js";

export interface ChannelTopicPort {
  /** Called inside the channel creator's transaction; never opens or commits a separate transaction. */
  createChannelTopic(
    transaction: Transaction<DatabaseSchema>,
    input: {
      readonly channelId: TeamChannelId;
      readonly name: string;
      readonly createdBy: UserId;
      readonly peopleOnly: boolean;
    },
  ): Promise<KnowledgeTopicId>;
}
