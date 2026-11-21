// The Home's coordinator suite, unchanged, against the real pool agent on a fake hypervisor:
// signed requests over HTTP, the agent's journal on disk, and the Home's real controller client.
(globalThis as { opensteerPoolController?: string }).opensteerPoolController = "agent";
await import("./browser-pool-coordinator.integration.test.js");
