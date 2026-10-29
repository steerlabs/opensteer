import { machineAccessPolicyDefault, type MachineAccessPolicy } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { machineAccessSummary } from "./machine-access-editor.js";

const place = { deploymentName: "Acme", machineName: "Mac mini" } as const;

function policy(overrides: Partial<MachineAccessPolicy> = {}): MachineAccessPolicy {
  return { ...machineAccessPolicyDefault, ...overrides };
}

describe("machineAccessSummary", () => {
  it("says nobody is reaching the computer, whatever else the draft holds", () => {
    expect(machineAccessSummary(machineAccessPolicyDefault, place)).toBe(
      "No other computer can reach Mac mini.",
    );
    // Grants survive a reach of nobody on purpose; the sentence still refuses
    // to imply anyone could use them.
    expect(
      machineAccessSummary(
        policy({ commands: true, shares: [{ mode: "read-write", path: "/srv" }] }),
        place,
      ),
    ).toBe("No other computer can reach Mac mini.");
  });

  it("names a reach that grants nothing as exactly that", () => {
    expect(machineAccessSummary(policy({ reach: "owner" }), place)).toBe(
      "Your agents can connect to Mac mini but can't open any folder or run anything yet.",
    );
    expect(machineAccessSummary(policy({ reach: "deployment" }), place)).toBe(
      "Agents in Acme can connect to Mac mini but can't open any folder or run anything yet.",
    );
  });

  it("counts folders and says how they may be opened", () => {
    const summary = (shares: MachineAccessPolicy["shares"]) =>
      machineAccessSummary(policy({ reach: "owner", shares }), place);

    expect(summary([{ mode: "read", path: "/a" }])).toBe(
      "Your agents can open 1 folder (read-only) on Mac mini.",
    );
    expect(
      summary([
        { mode: "read", path: "/a" },
        { mode: "read", path: "/b" },
      ]),
    ).toBe("Your agents can open 2 folders (read-only) on Mac mini.");
    expect(summary([{ mode: "read-write", path: "/a" }])).toBe(
      "Your agents can open 1 folder (read and write) on Mac mini.",
    );
    expect(
      summary([
        { mode: "read-write", path: "/a" },
        { mode: "read", path: "/b" },
        { mode: "read", path: "/c" },
      ]),
    ).toBe("Your agents can open 3 folders (1 writable) on Mac mini.");
  });

  it("leaves an unfinished row out, as a save would", () => {
    expect(
      machineAccessSummary(
        policy({
          reach: "owner",
          shares: [
            { mode: "read", path: "/a" },
            { mode: "read", path: "  " },
          ],
        }),
        place,
      ),
    ).toBe("Your agents can open 1 folder (read-only) on Mac mini.");
  });

  it("joins every grant the draft carries into one sentence", () => {
    expect(machineAccessSummary(policy({ commands: true, reach: "owner" }), place)).toBe(
      "Your agents can run commands on Mac mini.",
    );
    expect(machineAccessSummary(policy({ forwarding: true, reach: "owner" }), place)).toBe(
      "Your agents can reach local services on Mac mini.",
    );
    expect(
      machineAccessSummary(
        policy({
          commands: true,
          reach: "owner",
          shares: [
            { mode: "read", path: "/a" },
            { mode: "read", path: "/b" },
          ],
        }),
        place,
      ),
    ).toBe("Your agents can open 2 folders (read-only) and run commands on Mac mini.");
    expect(
      machineAccessSummary(
        policy({
          forwarding: true,
          reach: "deployment",
          shares: [{ mode: "read-write", path: "/a" }],
        }),
        place,
      ),
    ).toBe(
      "Agents in Acme can open 1 folder (read and write) and reach local services on Mac mini.",
    );
    expect(
      machineAccessSummary(
        policy({
          commands: true,
          forwarding: true,
          reach: "owner",
          shares: [{ mode: "read", path: "/a" }],
        }),
        place,
      ),
    ).toBe(
      "Your agents can open 1 folder (read-only), run commands and reach local services on Mac mini.",
    );
  });
});
