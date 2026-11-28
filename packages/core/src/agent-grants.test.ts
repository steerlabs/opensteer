import { describe, expect, it } from "vitest";
import {
  AgentGrantSchema,
  agentGrantAccess,
  agentGrantAllows,
  agentGrantAllowsTasks,
  agentGrantNarrowed,
  agentGrantToolFamilies,
  agentGrantMaxResources,
  minThreadAccessMode,
  type AgentGrantTarget,
} from "./agent-grants.js";

const profile = "bpr_00000000-0000-4000-8000-000000000001";
const otherProfile = "bpr_00000000-0000-4000-8000-000000000002";
const approval = "con_00000000-0000-4000-8000-0000000000aa";
const device = "dev_00000000-0000-4000-8000-0000000000dd";
const server = "isv_00000000-0000-4000-8000-0000000000ee";
const account = "con_00000000-0000-4000-8000-0000000000ff";

const selected = AgentGrantSchema.parse({
  scope: "selected",
  tasks: false,
  resources: [
    { kind: "browser-profile", profileId: profile },
    {
      kind: "computer-app",
      approvalId: approval.toUpperCase().replace("CON_", "con_"),
      deviceId: device,
      app: { kind: "mac-app", bundleId: "com.Example.App", teamId: "ABCDE12345" },
    },
    { kind: "plugin", target: { kind: "installed", pluginId: "gmail" }, access: "read-write" },
    { kind: "plugin", target: { kind: "installed", pluginId: "gmail" }, access: "read-write" },
    { kind: "plugin", target: { kind: "local-server", serverId: server }, access: "read" },
    { kind: "browser-profile", profileId: profile },
  ],
});

const app = (overrides: Partial<{ approvalId: string; teamId: string | null; bundleId: string }>) =>
  ({
    kind: "computer-app",
    approvalId: overrides.approvalId ?? approval,
    deviceId: device,
    app: {
      kind: "mac-app",
      bundleId: overrides.bundleId ?? "com.example.app",
      teamId: overrides.teamId === undefined ? "ABCDE12345" : overrides.teamId,
    },
  }) as const satisfies AgentGrantTarget;

describe("agent grants", () => {
  it("canonicalizes: dedupes by identity, keeps the widest plugin access, and sorts", () => {
    expect(selected.scope).toBe("selected");
    if (selected.scope !== "selected") return;
    expect(selected.resources).toHaveLength(4);
    expect(selected.resources.map((resource) => resource.kind)).toEqual([
      "browser-profile",
      "computer-app",
      "plugin",
      "plugin",
    ]);
    expect(
      selected.resources.find(
        (resource) => resource.kind === "plugin" && resource.target.kind === "installed",
      ),
    ).toMatchObject({ access: "read-write" });
    expect(AgentGrantSchema.parse(selected)).toEqual(selected);
  });

  it("refuses two different statements about one resource instead of merging them", () => {
    const base = { scope: "selected", tasks: false } as const;
    const plugin = (access: "read" | "read-write") => ({
      kind: "plugin",
      target: { kind: "installed", pluginId: "gmail" },
      access,
    });
    expect(
      AgentGrantSchema.safeParse({ ...base, resources: [plugin("read"), plugin("read-write")] })
        .success,
    ).toBe(false);
    const app = (teamId: string | null, deviceId = device) => ({
      kind: "computer-app",
      approvalId: approval,
      deviceId,
      app: { kind: "mac-app", bundleId: "com.example.app", teamId },
    });
    expect(
      AgentGrantSchema.safeParse({ ...base, resources: [app("ABCDE12345"), app(null)] }).success,
    ).toBe(false);
    expect(
      AgentGrantSchema.safeParse({
        ...base,
        resources: [
          app("ABCDE12345"),
          app("ABCDE12345", "dev_00000000-0000-4000-8000-0000000000de"),
        ],
      }).success,
    ).toBe(false);
  });

  it("treats a changed signer or Device on the same approval as a withdrawal", () => {
    if (selected.scope !== "selected") throw new Error("selected");
    const resigned = AgentGrantSchema.parse({
      ...selected,
      resources: selected.resources.map((resource) =>
        resource.kind === "computer-app"
          ? { ...resource, app: { ...resource.app, teamId: "ZZZZZ99999" } }
          : resource,
      ),
    });
    expect(agentGrantNarrowed(selected, resigned)).toBe(true);
  });

  it("bounds the grant and refuses unknown shapes", () => {
    const many = Array.from({ length: agentGrantMaxResources + 1 }, () => ({
      kind: "browser-profile",
      profileId: profile,
    }));
    expect(
      AgentGrantSchema.safeParse({ scope: "selected", tasks: true, resources: many }).success,
    ).toBe(false);
    expect(AgentGrantSchema.safeParse({ scope: "everything", tasks: true }).success).toBe(false);
    expect(AgentGrantSchema.safeParse({ scope: "full" }).success).toBe(false);
    expect(
      AgentGrantSchema.safeParse({
        scope: "selected",
        tasks: false,
        resources: [
          {
            kind: "computer-app",
            approvalId: approval,
            deviceId: device,
            app: { kind: "mac-app", bundleId: "x" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it.each<[string, AgentGrantTarget, "read" | "read-write" | null]>([
    ["the granted profile", { kind: "browser-profile", profileId: profile }, "read-write"],
    ["another profile", { kind: "browser-profile", profileId: otherProfile }, null],
    [
      "the approved app (bundle id case is not identity)",
      app({ bundleId: "COM.EXAMPLE.APP" }),
      "read-write",
    ],
    ["the app re-signed by another team", app({ teamId: "ZZZZZ99999" }), null],
    ["the app now unsigned", app({ teamId: null }), null],
    ["a replacement approval row", app({ approvalId: account }), null],
    [
      "the read-write plugin",
      { kind: "plugin", target: { kind: "installed", pluginId: "gmail" } },
      "read-write",
    ],
    [
      "the read-only local server",
      { kind: "plugin", target: { kind: "local-server", serverId: server } },
      "read",
    ],
    [
      "an ungranted device account",
      { kind: "plugin", target: { kind: "device-account", integrationConnectionId: account } },
      null,
    ],
    [
      "a removed plugin",
      { kind: "plugin", target: { kind: "installed", pluginId: "slack" } },
      null,
    ],
    ["a remote Device", { kind: "device" }, null],
  ])("a selected grant resolves %s", (_name, target, expected) => {
    expect(agentGrantAccess(selected, target)).toBe(expected);
    expect(agentGrantAccess({ scope: "everything" }, target)).toBe("read-write");
  });

  it("checks levels, tasks and tool families", () => {
    const localServer = {
      kind: "plugin",
      target: { kind: "local-server", serverId: server },
    } as const;
    expect(agentGrantAllows(selected, localServer, "read")).toBe(true);
    expect(agentGrantAllows(selected, localServer, "read-write")).toBe(false);
    expect(agentGrantAllowsTasks(selected)).toBe(false);
    expect(agentGrantAllowsTasks({ scope: "everything" })).toBe(true);
    expect([...agentGrantToolFamilies(selected)].sort()).toEqual([
      "browser",
      "computer",
      "plugins",
    ]);
    expect([...agentGrantToolFamilies({ scope: "selected", tasks: true, resources: [] })]).toEqual([
      "tasks",
    ]);
    expect(agentGrantToolFamilies({ scope: "everything" }).has("settings")).toBe(true);
  });

  it("tells a narrowing edit from a widening one", () => {
    const tasksOnly = AgentGrantSchema.parse({ scope: "selected", tasks: true, resources: [] });
    expect(agentGrantNarrowed({ scope: "everything" }, tasksOnly)).toBe(true);
    expect(agentGrantNarrowed(tasksOnly, { scope: "everything" })).toBe(false);
    expect(agentGrantNarrowed(selected, selected)).toBe(false);
    if (selected.scope !== "selected") return;
    const readOnly = AgentGrantSchema.parse({
      ...selected,
      resources: selected.resources.map((resource) =>
        resource.kind === "plugin" ? { ...resource, access: "read" } : resource,
      ),
    });
    expect(agentGrantNarrowed(selected, readOnly)).toBe(true);
    expect(agentGrantNarrowed(readOnly, selected)).toBe(false);
    expect(
      agentGrantNarrowed(selected, { ...selected, resources: selected.resources.slice(1) }),
    ).toBe(true);
  });

  it("takes the minimum of present modes", () => {
    expect(minThreadAccessMode("full-access", "auto", undefined)).toBe("auto");
    expect(minThreadAccessMode(null, "approval-required", "full-access")).toBe("approval-required");
    expect(() => minThreadAccessMode(null)).toThrow();
  });
});

it("canonicalizes a shared Chrome grant by exact source identity", () => {
  const sourceId = "bsr_00000000-0000-4000-8000-000000000001";
  const resource = { kind: "chrome-tabs", sourceId } as const;
  const grant = AgentGrantSchema.parse({
    scope: "selected",
    tasks: false,
    resources: [resource, resource],
  });
  expect(grant).toEqual({ scope: "selected", tasks: false, resources: [resource] });
  expect(agentGrantAccess(grant, resource)).toBe("read-write");
  expect(
    agentGrantAccess(grant, { ...resource, sourceId: sourceId.replace(/1$/u, "2") }),
  ).toBeNull();
  expect(agentGrantAccess(grant, { kind: "browser-profile", profileId: profile })).toBeNull();
  expect(agentGrantNarrowed(grant, { scope: "selected", tasks: false, resources: [] })).toBe(true);
  expect(
    AgentGrantSchema.safeParse({
      scope: "selected",
      tasks: false,
      resources: [{ ...resource, sourceId: profile }],
    }).success,
  ).toBe(false);
});
