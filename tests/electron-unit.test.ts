import { expect, it } from "vitest";

it("resolves electron to the network-free unit stub", async () => {
  const electron: Record<string, unknown> = await import("electron");
  expect(electron.default).toBeUndefined();
});
