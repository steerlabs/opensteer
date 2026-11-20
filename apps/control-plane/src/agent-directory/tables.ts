import type {
  AgentDirectoryEntryId,
  AgentDirectoryJwks,
  AgentDirectoryOrigin,
} from "@opensteer/control-plane-protocol";
import type { ColumnType, Generated } from "kysely";
import type { Timestamp } from "../database/schema.js";

export interface AgentDirectoryStateTable {
  id: number;
  revision: Generated<number>;
  updatedAt: Timestamp;
}

export interface AgentDirectoryEntryTable {
  id: AgentDirectoryEntryId;
  displayName: string;
  origins: ColumnType<readonly AgentDirectoryOrigin[], string, string>;
  keys: ColumnType<AgentDirectoryJwks | null, string | null, string | null>;
  embedsVia: ColumnType<readonly AgentDirectoryEntryId[] | null, string | null, string | null>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
