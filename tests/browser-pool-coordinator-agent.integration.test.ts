// The Home's coordinator suite, unchanged, against the real pool agent on a fake hypervisor:
// signed requests over HTTP, the agent's journal on disk, and the Home's real controller client.
// The suite runs on the integration database, through the store fixture it imports.
(globalThis as { opensteerPoolController?: string }).opensteerPoolController = "agent";
await import("../packages/database/src/store.integration.test-support.js");
await import("./browser-pool-coordinator.integration.test.js");
