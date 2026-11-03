import type { SignedTokenService } from "../identity/host-keys.js";

import {
  RunCapabilityTokenService,
  type RunCapabilityBindingAuthorizer,
  type RunCapabilityClaims,
} from "./run-capability.js";

export type RunToolScope = RunCapabilityClaims<"opensteer-agent-control">;

export class RunToolTokenService extends RunCapabilityTokenService<"opensteer-agent-control"> {
  constructor(options: {
    readonly authorizer: RunCapabilityBindingAuthorizer;
    readonly lifetimeSeconds?: number;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-agent-control" });
  }
}
