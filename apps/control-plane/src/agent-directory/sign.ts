import {
  AgentDirectoryClaimsSchema,
  AgentDirectoryDocumentSchema,
  agentDirectoryJwtTyp,
  agentDirectoryTokenUse,
  type AgentDirectoryDocument,
} from "@opensteer/control-plane-protocol";
import type { JWTPayload } from "jose";
import { signAccountDocument, type ControlPlaneAuth } from "../auth/auth.js";

export type AgentDirectorySigner = (
  payload: JWTPayload,
  options: { readonly typ: string },
) => Promise<string>;

export async function signAgentDirectoryDocument(options: {
  readonly document: AgentDirectoryDocument;
  readonly issuer: URL;
  readonly sign: AgentDirectorySigner;
  readonly now?: () => number;
}): Promise<string> {
  const document = AgentDirectoryDocumentSchema.parse(options.document);
  const nowMs = options.now?.() ?? Date.now();
  const claims = AgentDirectoryClaimsSchema.parse({
    ...document,
    tokenUse: agentDirectoryTokenUse,
    iss: options.issuer.origin,
    iat: Math.floor(nowMs / 1_000),
  });
  return options.sign(claims, { typ: agentDirectoryJwtTyp });
}

export function accountAgentDirectorySigner(auth: ControlPlaneAuth): AgentDirectorySigner {
  return (payload, options) => signAccountDocument(auth, payload, options);
}
