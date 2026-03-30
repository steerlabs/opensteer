export * from "../../../runtime-core/src/sdk/semantic-runtime.js";

import type { OpensteerSemanticRuntime } from "../../../runtime-core/src/sdk/semantic-runtime.js";

export interface OpensteerDisconnectableRuntime extends OpensteerSemanticRuntime {
  disconnect(): Promise<void>;
}
