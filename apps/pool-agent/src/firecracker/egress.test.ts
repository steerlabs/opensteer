/**
 * Round 4, item 2, found on the host: the slot proxy's service was started and stopped with
 * every wake and kill, hit systemd's default start limit (5 starts in 10 s), and took its socket
 * down with it, so the page's next request found nothing listening. The socket must hold every
 * connection until the proxy is up, however often it is started.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { command: string; args: readonly string[] }[] = [];
vi.mock("./exec.js", () => ({
  run: async (command: string, args: readonly string[]) => {
    calls.push({ command, args });
    return "inactive\n";
  },
}));

const { defineEgress } = await import("./egress.js");

beforeEach(() => {
  calls.length = 0;
});

describe("a slot's proxy unit", () => {
  it("has no start limit, and its socket no trigger limit", async () => {
    await defineEgress({ node: "/node", main: "/main.js" }, 3, 300_003, undefined);
    const unit = calls.find((call) => call.command === "systemd-run")!.args;
    expect(unit).toContain("--property=StartLimitIntervalSec=0");
    expect(unit).toContain("--socket-property=TriggerLimitIntervalSec=0");
  });
});
