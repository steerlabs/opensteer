import { type Thread, type Workspace } from "@opensteer/core";

import type { TriggerControlInput } from "@opensteer/triggers";

import type { SignedTokenService } from "../identity/host-keys.js";

import {
  RunCapabilityTokenService,
  type RunCapabilityBindingAuthorizer,
  type RunCapabilityClaims,
} from "./run-capability.js";

export type AgentControlRunScope = RunCapabilityClaims<"opensteer-agent-control">;

export interface AgentWorkspaceMountService {
  mount(input: {
    readonly requestId: string;
    readonly scope: AgentControlRunScope;
    readonly workspace: Workspace;
  }): Promise<{ readonly path: string }>;
}

export interface AgentWorkspaceCreator {
  projectPath(workspace: Workspace): Promise<string>;
  create(input: {
    readonly createdBy: AgentControlRunScope["requestedBy"];
    readonly idempotencyKey: string;
    readonly kind: "project";
    readonly name: string;
  }): Promise<Workspace>;
}

export interface AgentTriggerManager {
  manage(
    ownerId: AgentControlRunScope["requestedBy"],
    input: TriggerControlInput,
    actorThreadId: Thread["id"] | null,
  ): Promise<unknown>;
}

type AgentControlBindingAuthorizer = RunCapabilityBindingAuthorizer;

export class AgentControlTokenService extends RunCapabilityTokenService<"opensteer-agent-control"> {
  constructor(options: {
    readonly authorizer: AgentControlBindingAuthorizer;
    readonly lifetimeSeconds?: number;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-agent-control" });
  }
}
