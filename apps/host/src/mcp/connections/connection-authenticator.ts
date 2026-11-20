import {
  OpensteerError,
  everythingAgentGrant,
  type AgentGrant,
  type ThreadAccessMode,
  type UserId,
} from "@opensteer/core";
import type { AgentConnectionStore } from "@opensteer/database";
import { createHash } from "node:crypto";

export const connectionCredentialPrefix = "ost_mcp_";
export function credentialHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export interface AuthenticatedConnection {
  readonly connectionId: string;
  readonly userId: UserId;
  readonly accessMode: ThreadAccessMode;
  readonly grant: AgentGrant;
  readonly grantRevision: number;
  readonly consentVersion: number;
}

/** No session cache: an MCP session ID never substitutes for a live bearer check. */
export class ConnectionAuthenticator {
  readonly store: Pick<AgentConnectionStore, "authenticate">;
  constructor(store: Pick<AgentConnectionStore, "authenticate">) {
    this.store = store;
  }

  async authenticate(bearer: string, resource?: string): Promise<AuthenticatedConnection> {
    if (!/^ost_mcp_[A-Za-z0-9_-]{43}$/.test(bearer)) throw invalidConnection();
    const connection = await this.store.authenticate(credentialHash(bearer), resource);
    if (!connection) throw invalidConnection();
    return {
      connectionId: connection.id,
      userId: connection.userId,
      accessMode: connection.accessMode,
      grant: connection.grant ?? everythingAgentGrant,
      grantRevision: connection.grantRevision ?? 1,
      consentVersion: connection.consentVersion ?? 1,
    };
  }
}
function invalidConnection() {
  return new OpensteerError({
    code: "unauthorized",
    message: "The connected agent credential is invalid or expired.",
  });
}
