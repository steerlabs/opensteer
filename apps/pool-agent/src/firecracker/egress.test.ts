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

const { defineEgress, sleepEgress } = await import("./egress.js");

beforeEach(() => {
  calls.length = 0;
});

describe("a slot's proxy unit (round D, D1)", () => {
  it("keeps systemd's crash protection, backs off, and runs in its own bounded slice", async () => {
    await defineEgress({ node: "/node", main: "/main.js" }, 3, 300_003, undefined);
    const unit = calls.find((call) => call.command === "systemd-run")!.args;
    expect(unit).not.toContain("--property=StartLimitIntervalSec=0");
    expect(unit).not.toContain("--socket-property=TriggerLimitIntervalSec=0");
    expect(unit).toEqual(
      expect.arrayContaining([
        "--slice=opensteer-pool-egress.slice",
        "--property=StartLimitBurst=5",
        "--property=RestartSteps=5",
        "--property=CPUQuota=100%",
        "--property=CPUWeight=100",
      ]),
    );
  });

  it("does not count the agent's own stops against the start limit", async () => {
    await sleepEgress(3);
    const commands = calls.map((call) => [call.command, ...call.args].join(" "));
    expect(commands).toContain(
      "systemctl reset-failed opensteer-pool-egress-3.service opensteer-pool-egress-3.socket",
    );
  });
});
