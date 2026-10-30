import { expect, it, vi } from "vitest";

const candidate = vi.hoisted(() => ({ port: 6000 }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomInt: () => candidate.port - 1024,
}));

import { freePort } from "./loopbackPort.test-support.js";

const blockedPorts = [
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
];

it("never allocates a port blocked by Fetch", async () => {
  for (const port of blockedPorts) {
    candidate.port = port;
    expect(blockedPorts).not.toContain(await freePort());
  }
});
