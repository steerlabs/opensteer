import type { createMockHostPort as mockFactory } from "./mock-host-port.js";

export const createMockHostPort: typeof mockFactory = () => {
  throw new Error("Mock Host is not included in this build.");
};
