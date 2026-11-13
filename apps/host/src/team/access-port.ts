import type {
  KnowledgeTopicId,
  Sequence,
  TeamActor,
  TeamAgentRequestId,
  TeamChannelId,
  TeamLinkId,
  UserId,
} from "@opensteer/core";
import type { Transaction } from "kysely";
import type { DatabaseSchema } from "@opensteer/database";

export interface TeamChannelAuthority {
  readonly read: boolean;
  readonly post: boolean;
  readonly manage: boolean;
  readonly peopleOnly: boolean;
}
export interface TeamTopicAuthority {
  readonly read: boolean;
  readonly write: boolean;
  readonly manage: boolean;
}
export interface TeamAccessEffects {
  readonly users: readonly UserId[];
  readonly channels: readonly TeamChannelId[];
  readonly topics: readonly KnowledgeTopicId[];
  readonly links: readonly TeamLinkId[];
  readonly requests: readonly TeamAgentRequestId[];
}
export interface TeamAccessResolver {
  channel(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    channelId: TeamChannelId,
  ): Promise<TeamChannelAuthority>;
  topic(
    transaction: Transaction<DatabaseSchema>,
    actor: TeamActor,
    topicId: KnowledgeTopicId,
  ): Promise<TeamTopicAuthority>;
}
export interface TeamAccessLockPort {
  /** FOR UPDATE on team_access_state first, then affected rows in ID order; terminalize requests/revoke links before commit. */
  /** After commit, close affected sockets/link sockets/file streams and advance the revision before returning. */
  mutate<Value>(
    write: (
      transaction: Transaction<DatabaseSchema>,
    ) => Promise<{ readonly value: Value; readonly effects: TeamAccessEffects }>,
  ): Promise<Value>;
  /** FOR SHARE first, then channel FOR UPDATE and authorize inside; share lock remains held through the callback's actual COMMIT. */
  contentWrite<Value>(
    actor: TeamActor,
    channelId: TeamChannelId,
    write: (
      transaction: Transaction<DatabaseSchema>,
      authority: TeamChannelAuthority,
    ) => Promise<Value>,
  ): Promise<Value>;
  /** Lock access FOR SHARE, run the write (which authorizes inside), and hold the lock through its COMMIT. */
  knowledgeWrite<Value>(
    write: (transaction: Transaction<DatabaseSchema>) => Promise<Value>,
  ): Promise<Value>;
  readonly revision: Sequence;
  /** Reauthorize on revision change; discard the whole buffered result on access loss. */
  handoff<Value>(
    authorizedAt: Sequence,
    authorize: () => Promise<boolean>,
    deliver: () => Value,
  ): Promise<Value>;
}
