import { RunnerIdSchema, createId, type RunnerId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  MachineAccessPolicySchema,
  MachineAccessRunContextSchema,
  MachineAliasSchema,
  HostToShellModuleMessageSchema,
  RunnerShellModuleSchema,
  ShellDataTicketClaimsSchema,
  ShellModuleToHostMessageSchema,
  ShellSessionIdSchema,
  allocateMachineAliases,
  budgetReachableMachines,
  isCanonicalEd25519SshPublicKey,
  machineAccessMaxMachines,
  machineAccessMaxShares,
  machineAccessShareComponents,
  machineAccessShareIssues,
  machineAccessSharePathByteLength,
  machineAccessSharePathMaxBytes,
  machineAliasMaxLength,
  type MachineAccessRunMachine,
} from "./shell.js";

/** A structurally canonical ssh-ed25519 key (prefix + 32 bytes), for schemas. */
const canonicalHostKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";

/** Ids sort lexicographically, so a fixed prefix makes allocation order explicit. */
function runnerId(ordinal: number): RunnerId {
  const suffix = ordinal.toString(16).padStart(12, "0");
  return RunnerIdSchema.parse(`rnr_00000000-0000-4000-8000-${suffix}`);
}

describe("machine access share paths", () => {
  it("accepts an absolute, component-normalized path", () => {
    expect(machineAccessShareComponents("/Users/person/Pictures")).toEqual([
      "Users",
      "person",
      "Pictures",
    ]);
  });

  it("refuses everything that is not already normalized", () => {
    for (const path of [
      "Users/person",
      "~/Pictures",
      "/Users/person/../root",
      "/Users/person/./Pictures",
      "/Users/person//Pictures",
      "/Users/person/",
      "/",
    ]) {
      expect(machineAccessShareComponents(path), path).toBeNull();
    }
  });

  it("names the overlap when shares duplicate or nest", () => {
    expect(
      machineAccessShareIssues([
        { mode: "read", path: "/Users/person/Pictures" },
        { mode: "read", path: "/Users/person/Pictures" },
      ]),
    ).toEqual(["/Users/person/Pictures is shared twice."]);
    expect(
      machineAccessShareIssues([
        { mode: "read", path: "/Users/person/Pictures" },
        { mode: "read-write", path: "/Users/person/Pictures/Raw" },
      ]),
    ).toEqual([
      "/Users/person/Pictures/Raw is inside /Users/person/Pictures, which is already shared.",
    ]);
    expect(
      machineAccessShareIssues([
        { mode: "read", path: "/Users/person/Pictures/Raw" },
        { mode: "read-write", path: "/Users/person/Pictures" },
      ]),
    ).toEqual([
      "/Users/person/Pictures contains /Users/person/Pictures/Raw, which is already shared.",
    ]);
  });

  it("measures a path in the UTF-8 bytes the helper measures it in", () => {
    // Three bytes a character: 341 of them plus the leading slash is exactly
    // 1,024 bytes, one more overruns, and both are far inside any UTF-16
    // length limit — which is how a saved policy became a computer no session
    // could open.
    const fits = `/${"日".repeat(341)}`;
    const overruns = `/${"日".repeat(342)}`;
    expect(machineAccessSharePathByteLength(fits)).toBe(machineAccessSharePathMaxBytes);
    expect(fits.length).toBeLessThan(machineAccessSharePathMaxBytes);
    expect(overruns.length).toBeLessThan(machineAccessSharePathMaxBytes);

    expect(machineAccessShareComponents(fits)).toEqual(["日".repeat(341)]);
    expect(machineAccessShareIssues([{ mode: "read", path: fits }])).toEqual([]);
    expect(machineAccessShareComponents(overruns)).toBeNull();
    expect(machineAccessShareIssues([{ mode: "read", path: overruns }])).toEqual([
      `${overruns} is 1,027 bytes long; a shared folder path must be at most 1,024 bytes of UTF-8.`,
    ]);
  });

  it("refuses a path carrying a NUL rather than naming a different folder", () => {
    expect(machineAccessShareComponents("/Users/person/Pictures\u0000/etc")).toBeNull();
    expect(
      machineAccessShareIssues([{ mode: "read", path: "/Users/person/Pictures\u0000" }]),
    ).toEqual(["A shared folder path cannot contain a NUL character."]);
    expect(
      MachineAccessPolicySchema.safeParse({
        commands: false,
        forwarding: false,
        reach: "nobody",
        shares: [{ mode: "read", path: "/Users/person/Pictures\u0000" }],
      }).success,
    ).toBe(false);
  });

  it("compares by component rather than by string prefix", () => {
    expect(
      machineAccessShareIssues([
        { mode: "read", path: "/Users/person/Pictures" },
        { mode: "read", path: "/Users/person/Pictures2" },
      ]),
    ).toEqual([]);
  });
});

describe("MachineAccessPolicySchema", () => {
  it("rejects overlapping shares with the sentence naming both", () => {
    const parsed = MachineAccessPolicySchema.safeParse({
      commands: true,
      forwarding: false,
      reach: "owner",
      shares: [
        { mode: "read", path: "/srv/data" },
        { mode: "read-write", path: "/srv/data/in" },
      ],
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      "/srv/data/in is inside /srv/data, which is already shared.",
    ]);
  });

  it("bounds the share list", () => {
    const shares = Array.from({ length: 33 }, (_, index) => ({
      mode: "read" as const,
      path: `/srv/data-${index}`,
    }));
    expect(
      MachineAccessPolicySchema.safeParse({
        commands: false,
        forwarding: false,
        reach: "deployment",
        shares,
      }).success,
    ).toBe(false);
  });
});

describe("allocateMachineAliases", () => {
  it("slugs names and is stable under input order", () => {
    const machines = [
      { name: "Example Mac", runnerId: runnerId(2) },
      { name: "build box", runnerId: runnerId(1) },
    ];
    const expected = new Map([
      [runnerId(1), "build-box"],
      [runnerId(2), "example-mac"],
    ]);
    expect(allocateMachineAliases(machines)).toEqual(expected);
    expect(allocateMachineAliases([...machines].reverse())).toEqual(expected);
  });

  it("falls back to computer when the name slugs to nothing", () => {
    expect(allocateMachineAliases([{ name: "···", runnerId: runnerId(1) }])).toEqual(
      new Map([[runnerId(1), "computer"]]),
    );
    expect(
      allocateMachineAliases([
        { name: "···", runnerId: runnerId(1) },
        { name: "!!!", runnerId: runnerId(2) },
      ]),
    ).toEqual(
      new Map([
        [runnerId(1), "computer"],
        [runnerId(2), "computer-2"],
      ]),
    );
  });

  it("allocates duplicates in runnerId order against one used set", () => {
    expect(
      allocateMachineAliases([
        { name: "mac", runnerId: runnerId(3) },
        { name: "mac", runnerId: runnerId(1) },
        { name: "mac", runnerId: runnerId(2) },
      ]),
    ).toEqual(
      new Map([
        [runnerId(1), "mac"],
        [runnerId(2), "mac-2"],
        [runnerId(3), "mac-3"],
      ]),
    );
  });

  it("steps past a machine literally named like a suffix", () => {
    expect(
      allocateMachineAliases([
        { name: "mac", runnerId: runnerId(1) },
        { name: "mac-2", runnerId: runnerId(2) },
        { name: "mac", runnerId: runnerId(3) },
      ]),
    ).toEqual(
      new Map([
        [runnerId(1), "mac"],
        [runnerId(2), "mac-2"],
        [runnerId(3), "mac-3"],
      ]),
    );
  });

  it("keeps every alias inside the wire pattern, however long the names are", () => {
    const machines = Array.from({ length: 32 }, (_, index) => ({
      name: `${"z".repeat(160)}`,
      runnerId: runnerId(index + 1),
    }));
    const aliases = [...allocateMachineAliases(machines).values()];
    expect(new Set(aliases).size).toBe(32);
    for (const alias of aliases) {
      expect(alias.length).toBeLessThanOrEqual(machineAliasMaxLength);
      expect(MachineAliasSchema.safeParse(alias).success, alias).toBe(true);
    }
  });

  it("never leaves a truncated alias ending in a separator", () => {
    const aliases = allocateMachineAliases([
      { name: `${"a".repeat(62)} b`, runnerId: runnerId(1) },
    ]);
    expect(aliases.get(runnerId(1))).toBe("a".repeat(62));
  });

  it("collapses an all-non-ASCII name to the fallback", () => {
    expect(allocateMachineAliases([{ name: "日本語のマシン", runnerId: runnerId(1) }])).toEqual(
      new Map([[runnerId(1), "computer"]]),
    );
  });

  it("keeps a numbered alias within the limit when the stem is already maximal", () => {
    // Nine 63-char names take mac…mac then mac…-2 … mac…-9; the tenth needs a
    // two-digit suffix, whose base must shrink to 60 so the whole stays ≤ 63.
    const machines = Array.from({ length: 10 }, (_, index) => ({
      name: "m".repeat(63),
      runnerId: runnerId(index + 1),
    }));
    const aliases = allocateMachineAliases(machines);
    const tenth = aliases.get(runnerId(10));
    expect(tenth).toBe(`${"m".repeat(60)}-10`);
    expect(tenth?.length).toBe(63);
    expect(new Set(aliases.values()).size).toBe(10);
    for (const alias of aliases.values()) {
      expect(alias.length).toBeLessThanOrEqual(machineAliasMaxLength);
    }
  });

  it("steps past a name equal to another machine's numbered form", () => {
    // "box" then "box-2" then another "box": the third cannot take "box-2"
    // because the second already holds it literally, so it lands on "box-3".
    expect(
      allocateMachineAliases([
        { name: "box", runnerId: runnerId(1) },
        { name: "box-2", runnerId: runnerId(2) },
        { name: "box", runnerId: runnerId(3) },
      ]),
    ).toEqual(
      new Map([
        [runnerId(1), "box"],
        [runnerId(2), "box-2"],
        [runnerId(3), "box-3"],
      ]),
    );
  });
});

describe("isCanonicalEd25519SshPublicKey", () => {
  it("accepts a single canonical key", () => {
    expect(isCanonicalEd25519SshPublicKey(canonicalHostKey)).toBe(true);
    expect(
      RunnerShellModuleSchema.safeParse({
        hostPublicKey: canonicalHostKey,
        platform: "linux",
      }).success,
    ).toBe(true);
  });

  it("carries the macOS grant as the machine's own optional claim", () => {
    expect(
      RunnerShellModuleSchema.safeParse({
        fullDiskAccess: false,
        hostPublicKey: canonicalHostKey,
        platform: "darwin",
      }).success,
    ).toBe(true);
    expect(
      RunnerShellModuleSchema.safeParse({
        fullDiskAccess: "yes",
        hostPublicKey: canonicalHostKey,
        platform: "darwin",
      }).success,
    ).toBe(false);
    expect(
      RunnerShellModuleSchema.parse({
        hostPublicKey: canonicalHostKey,
        platform: "darwin",
        trash: true,
      }),
    ).toEqual({ hostPublicKey: canonicalHostKey, platform: "darwin" });
  });

  it("refuses anything that is not exactly that blob", () => {
    for (const value of [
      "ssh-rsa AAAAC3NzaC1lZDI1NTE5AAAAIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH",
      `${canonicalHostKey} alex@mac`,
      `ssh-ed25519 ${"A".repeat(68)}`,
      "ssh-ed25519 not-base64!!",
      `${canonicalHostKey}=`,
      "ssh-ed25519",
      canonicalHostKey.replace("ssh-ed25519 ", ""),
    ]) {
      expect(isCanonicalEd25519SshPublicKey(value), value).toBe(false);
    }
  });
});

function machine(index: number, shareCount: number): MachineAccessRunMachine {
  return {
    alias: `m-${index}`,
    commands: true,
    forwarding: false,
    fullDiskAccess: null,
    hostPublicKey: canonicalHostKey,
    lastSeenAt: null,
    name: `machine-${index}`,
    platform: "linux",
    runnerId: runnerId(index + 1),
    shares: Array.from({ length: shareCount }, (_, share) => ({
      mode: "read" as const,
      path: `/srv/${"d".repeat(1_000)}-${index}-${share}`,
    })),
    status: "online" as const,
  };
}

/**
 * A list whose own serialization is exactly the budget, to the byte.
 *
 * Measured bare, every entry fits. Measured as the object that actually
 * travels — braces, key names and the omission count included — the last one
 * does not, which is the whole difference between the two ways of counting.
 * The padding is whole shares of legal length, never one enormous path, so the
 * fixture is something the rest of the contract would accept.
 */
function machinesFillingTheBudget(): MachineAccessRunMachine[] {
  const budget = 128 * 1_024;
  const machines = Array.from({ length: 15 }, (_, index) => ({
    ...machine(index, 8),
    // Zero-padded so name order and index order are the same one, which makes
    // "the last entry is the one that does not fit" mean what it says.
    name: `machine-${index.toString().padStart(2, "0")}`,
  }));
  const last = machines.at(-1);
  if (!last) throw new Error("unreachable");
  const shares = [...last.shares];
  const size = () => {
    machines[machines.length - 1] = { ...last, shares };
    return JSON.stringify(machines).length;
  };
  const pad = (length: number) =>
    shares.push({ mode: "read" as const, path: `/pad/${shares.length}/${"e".repeat(length)}` });
  while (budget - size() > 1_100) pad(900);
  while (budget - size() > 200) pad(100);
  const tail = shares.at(-1);
  if (!tail || shares.length > machineAccessMaxShares) {
    throw new Error("the fixture cannot be tuned to the budget");
  }
  shares[shares.length - 1] = { ...tail, path: `${tail.path}${"e".repeat(budget - size())}` };
  if (size() !== budget) throw new Error("the fixture missed the budget");
  return machines;
}

describe("budgetReachableMachines", () => {
  it("keeps at most 32 entries", () => {
    const machines = Array.from({ length: 40 }, (_, index) => machine(index, 0));
    const budgeted = budgetReachableMachines("cloud-1", machines);
    expect(budgeted.machines).toHaveLength(machineAccessMaxMachines);
    expect(budgeted.omittedMachines).toBe(8);
  });

  it("drops from the end at the serialized-byte boundary", () => {
    // 32 machines each holding 32 × ~1 KiB share paths overruns 128 KiB, so
    // some are omitted rather than any share path being truncated.
    const machines = Array.from({ length: 32 }, (_, index) => machine(index, 32));
    const budgeted = budgetReachableMachines("cloud-1", machines);
    expect(budgeted.machines.length).toBeLessThan(32);
    expect(budgeted.omittedMachines).toBeGreaterThan(0);
    expect(budgeted.machines.length + budgeted.omittedMachines).toBe(32);
    expect(
      MachineAccessRunContextSchema.safeParse({
        callerMachineName: budgeted.callerMachineName,
        machines: budgeted.machines,
        omittedMachines: budgeted.omittedMachines,
      }).success,
    ).toBe(true);
    // The kept machines keep their full share lists — nothing is truncated.
    for (const kept of budgeted.machines) expect(kept.shares).toHaveLength(32);
  });

  it("chooses the machines that fit by name, with the runner id breaking ties", () => {
    // Ids run the opposite way from names, so a selection that read ids would
    // keep the other half of this list entirely.
    const machines = Array.from({ length: 40 }, (_, index) => ({
      ...machine(index, 0),
      name: `machine-${(39 - index).toString().padStart(2, "0")}`,
    }));
    const budgeted = budgetReachableMachines("cloud-1", machines);

    expect(budgeted.machines.map((kept) => kept.name)).toEqual(
      Array.from(
        { length: machineAccessMaxMachines },
        (_, index) => `machine-${index.toString().padStart(2, "0")}`,
      ),
    );
    expect(budgeted.omittedMachines).toBe(8);
  });

  it("breaks a name tie by runner id, and keeps that order stable", () => {
    const tied = [3, 1, 2].map((index) => ({ ...machine(index, 0), name: "example-mac" }));
    expect(budgetReachableMachines("cloud-1", tied).machines.map((kept) => kept.runnerId)).toEqual([
      runnerId(2),
      runnerId(3),
      runnerId(4),
    ]);
  });

  it("budgets the whole machineAccess object, not just its machines array", () => {
    const machines = machinesFillingTheBudget();
    expect(JSON.stringify(machines)).toHaveLength(128 * 1_024);

    const budgeted = budgetReachableMachines("cloud-1", machines);

    expect(budgeted.machines).toHaveLength(machines.length - 1);
    expect(budgeted.omittedMachines).toBe(1);
    expect(
      JSON.stringify({
        callerMachineName: budgeted.callerMachineName,
        machines: budgeted.machines,
        omittedMachines: budgeted.omittedMachines,
      }).length,
    ).toBeLessThanOrEqual(128 * 1_024);
  });
});

describe("MachineAccessRunContextSchema", () => {
  it("requires a bounded display name even without reachable computers", () => {
    const base = { machines: [], omittedMachines: 0 };
    for (const callerMachineName of [undefined, "", "x".repeat(161)]) {
      expect(MachineAccessRunContextSchema.safeParse({ ...base, callerMachineName }).success).toBe(
        false,
      );
    }
    for (const callerMachineName of ["界".repeat(160), "\u0000".repeat(160)]) {
      const context = MachineAccessRunContextSchema.parse({
        ...base,
        callerMachineName,
        omittedMachines: Number.MAX_SAFE_INTEGER,
      });
      expect(Buffer.byteLength(JSON.stringify(context), "utf8")).toBeLessThan(128 * 1_024);
    }
  });

  it("counts the UTF-8 display name when selecting machines at the boundary", () => {
    const callerMachineName = "界".repeat(160);
    const machines = machinesFillingTheBudget();
    const tail = machines.at(-1)!.shares.at(-1)!;
    const excess =
      Buffer.byteLength(
        JSON.stringify({ callerMachineName: "a", machines, omittedMachines: 0 }),
        "utf8",
      ) -
      128 * 1_024;
    tail.path = tail.path.slice(0, -excess);
    expect(budgetReachableMachines("a", machines).machines).toHaveLength(machines.length);
    const budgeted = budgetReachableMachines(callerMachineName, machines);
    expect(budgeted.callerMachineName).toBe(callerMachineName);
    expect(budgeted.machines).toHaveLength(machines.length - 1);
    expect(Buffer.byteLength(JSON.stringify(budgeted), "utf8")).toBeLessThanOrEqual(128 * 1_024);
  });

  it("validates the complete object against the budget, not only its machines", () => {
    const machines = machinesFillingTheBudget();
    // The list alone is exactly the budget, so a check that measured only the
    // list would admit this — and the Run command would then carry an object
    // that is over it by the length of its own braces and keys.
    expect(JSON.stringify(machines)).toHaveLength(128 * 1_024);

    expect(
      MachineAccessRunContextSchema.safeParse({
        callerMachineName: "cloud-1",
        machines,
        omittedMachines: 0,
      }).success,
    ).toBe(false);
    // What the producer hands over is measured the same way, so it passes.
    expect(
      MachineAccessRunContextSchema.safeParse(budgetReachableMachines("cloud-1", machines)).success,
    ).toBe(true);
  });
});

describe("shell wire schemas", () => {
  const sessionId = ShellSessionIdSchema.parse("shs_11111111-1111-4111-8111-111111111111");

  it("carries the standard auxiliary fence on every module message", () => {
    const fence = {
      auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
      bootId: "rbt_11111111-1111-4111-8111-111111111111",
      connectionGeneration: 1,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111",
      connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
      module: "shell",
      runnerId: createId("runner"),
    };
    expect(
      ShellModuleToHostMessageSchema.safeParse({
        ...fence,
        sessionId,
        type: "runner.shell.session.opened",
      }).success,
    ).toBe(true);
    expect(
      ShellModuleToHostMessageSchema.safeParse({
        sessionId,
        type: "runner.shell.session.opened",
      }).success,
    ).toBe(false);
  });

  it("carries the target machine name on open and audit loss on close", () => {
    const fence = {
      auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
      bootId: "rbt_11111111-1111-4111-8111-111111111111",
      connectionGeneration: 1,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111",
      connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
      module: "shell",
      runnerId: createId("runner"),
    } as const;
    const open = {
      ...fence,
      authority: {
        callerMachineName: "Caller Mac",
        policyRevision: 1,
        requestedBy: createId("user"),
        runId: createId("run"),
        sessionId,
        startedAt: new Date().toISOString(),
        threadId: createId("thread"),
        threadTitle: "Test shell",
        workspaceId: createId("workspace"),
      },
      dataTicket: "aaaa.bbbb.cccc",
      machineName: "Build box",
      policy: { commands: true, forwarding: false, reach: "deployment", shares: [] },
      sessionId,
      type: "host.shell.session.open",
    } as const;
    expect(HostToShellModuleMessageSchema.parse(open)).toMatchObject({ machineName: "Build box" });
    const { machineName: _machineName, ...missingMachineName } = open;
    expect(HostToShellModuleMessageSchema.safeParse(missingMachineName).success).toBe(false);
    expect(
      ShellModuleToHostMessageSchema.parse({
        ...fence,
        auditDropped: 7,
        reason: "target-closed",
        sessionId,
        type: "runner.shell.session.closed",
      }),
    ).toMatchObject({ auditDropped: 7 });
    expect(
      ShellModuleToHostMessageSchema.safeParse({
        ...fence,
        auditDropped: -1,
        reason: "target-closed",
        sessionId,
        type: "runner.shell.session.closed",
      }).success,
    ).toBe(false);
  });

  it("binds a data ticket to the complete stream fence", () => {
    const claims = {
      audience: "opensteer-shell-data",
      auxiliaryStreamId: "rax_11111111-1111-4111-8111-111111111111",
      bootId: "rbt_11111111-1111-4111-8111-111111111111",
      connectionGeneration: 1,
      connectionId: "rcn_11111111-1111-4111-8111-111111111111",
      connectionLeaseId: "rls_11111111-1111-4111-8111-111111111111",
      expiresAt: new Date().toISOString(),
      issuedAt: new Date().toISOString(),
      module: "shell",
      nonce: "a".repeat(32),
      runnerId: createId("runner"),
      sessionId,
      type: "opensteer.shell.data-ticket",
    };
    expect(ShellDataTicketClaimsSchema.safeParse(claims).success).toBe(true);
    // Missing the lease or the stream id — half a fence — is refused.
    for (const field of ["connectionLeaseId", "auxiliaryStreamId", "type"] as const) {
      const { [field]: _removed, ...rest } = claims;
      expect(ShellDataTicketClaimsSchema.safeParse(rest).success, field).toBe(false);
    }
    // The auxiliary stream ticket's own audience cannot pass as a data ticket.
    expect(
      ShellDataTicketClaimsSchema.safeParse({
        ...claims,
        audience: "opensteer-runner-auxiliary",
      }).success,
    ).toBe(false);
  });
});
