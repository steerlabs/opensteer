import type {
  AgentDirectoryEntryId,
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
  createdAt: Timestamp;
  updatedAt: Timestamp;
}
