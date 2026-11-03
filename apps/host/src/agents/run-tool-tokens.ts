import type { SignedTokenService } from "../identity/host-keys.js";

import {
  RunCapabilityTokenService,
  type RunCapabilityBindingAuthorizer,
  type RunCapabilityClaims,
} from "./run-capability.js";

export type RunToolScope = RunCapabilityClaims<"opensteer-run-tools">;

export class RunToolTokenService extends RunCapabilityTokenService<"opensteer-run-tools"> {
  constructor(options: {
    readonly authorizer: RunCapabilityBindingAuthorizer;
    readonly lifetimeSeconds?: number;
    readonly tokens: SignedTokenService;
  }) {
    super({ ...options, audience: "opensteer-run-tools" });
  }
}
