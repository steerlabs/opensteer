import { testDiscoveryEnvelope } from "@opensteer/client/test-support";
import { PersonalHostRuntimeRecordSchema } from "./personal-host-runtime.js";

export function testPersonalHostRuntime(input: Record<string, unknown>) {
  return PersonalHostRuntimeRecordSchema.parse({
    ...input,
    discoveryEnvelope: testDiscoveryEnvelope(input.discovery),
    schemaVersion: 2,
  });
}
