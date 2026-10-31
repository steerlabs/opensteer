import { AgentCapabilityProfileIdSchema } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentCapabilityProfile,
  agentCapabilityProfiles,
  agentToolDefinitions,
  capabilityProfileAllowsTool,
  opensteerPlatformGuide,
  platformGuideForCapabilityProfile,
  platformGuideForRun,
  toolsForCapabilityProfile,
} from "./catalog.js";
import { skillsForCapabilityProfile } from "./skills.js";

const expectedTools = {
  delegated: [
    "request_list",
    "request_withdraw",
    "environment_list",
    "thread_read",
    "thread_list",
    "thread_delegate",
    "assignment_cancel",
    "person_notify",
    "thread_message",
    "thread_write",
    "browser_profile_list",
    "sign_in",
    "browser_tab_read",
    "browser_tab_write",
    "browser_session_list",
    "browser_session_open",
    "trigger_read",
    "trigger_write",
  ],
  main: [
    "request_list",
    "request_withdraw",
    "environment_list",
    "workspace_list",
    "workspace_create",
    "workspace_mount",
    "thread_read",
    "thread_list",
    "thread_delegate",
    "assignment_cancel",
    "person_notify",
    "thread_message",
    "thread_write",
    "browser_profile_list",
    "sign_in",
    "browser_access_request",
    "machine_full_disk_access_request",
    "browser_tab_read",
    "browser_tab_write",
    "browser_session_list",
    "browser_session_open",
    "browser_profile_create",
    "browser_session_close",
    "trigger_read",
    "trigger_write",
  ],
  trigger: [
    "environment_list",
    "workspace_list",
    "workspace_create",
    "thread_read",
    "thread_delegate",
    "thread_message",
    "trigger_read",
    "trigger_write",
  ],
  workspace: [
    "request_list",
    "request_withdraw",
    "environment_list",
    "thread_read",
    "thread_list",
    "thread_delegate",
    "assignment_cancel",
    "person_notify",
    "thread_message",
    "thread_write",
    "browser_profile_list",
    "sign_in",
    "browser_access_request",
    "machine_full_disk_access_request",
    "browser_tab_read",
    "browser_tab_write",
    "browser_session_list",
    "browser_session_open",
    "browser_session_close",
    "trigger_read",
    "trigger_write",
  ],
} as const;

describe("agent tool catalog", () => {
  it("exposes one exact tool list for each capability profile", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      expect(toolsForCapabilityProfile(profileId).map(({ name }) => name)).toEqual(
        expectedTools[profileId],
      );
    }
    expect(capabilityProfileAllowsTool("main", "trigger.write")).toBe(true);
    expect(capabilityProfileAllowsTool("delegated", "thread.delegate")).toBe(true);
  });

  it("selects the role-specific browser access request schema", () => {
    const main = tool("main", "browser_access_request");
    const workspace = tool("workspace", "browser_access_request");

    expect(main.inputSchema.safeParse(browserAccessInput()).success).toBe(false);
    expect(
      main.inputSchema.safeParse({
        ...browserAccessInput(),
        workspaceId: "wsp_00000000-0000-4000-a000-000000000000",
      }).success,
    ).toBe(true);
    expect(workspace.inputSchema.safeParse(browserAccessInput()).success).toBe(true);
    expect(
      workspace.inputSchema.safeParse({
        ...browserAccessInput(),
        workspaceId: "wsp_00000000-0000-4000-a000-000000000000",
      }).success,
    ).toBe(false);
  });

  it("keeps browser session identity explicit", () => {
    const schema = tool("main", "browser_session_open").inputSchema;
    expect(schema.safeParse({ fresh: true }).success).toBe(true);
    expect(
      schema.safeParse({ profileId: "bpr_00000000-0000-4000-a000-000000000000" }).success,
    ).toBe(true);
    expect(schema.safeParse({}).success).toBe(false);
    expect(
      schema.safeParse({
        fresh: true,
        sessionId: "bsn_00000000-0000-4000-a000-000000000000",
      }).success,
    ).toBe(false);
  });

  it("lets a browser session name the machine that runs it", () => {
    const schema = tool("main", "browser_session_open").inputSchema;
    expect(
      schema.safeParse({
        environmentId: "env_00000000-0000-4000-a000-000000000000",
        fresh: true,
      }).success,
    ).toBe(true);
    // A machine is not an identity, so naming one still leaves the identity
    // choice required.
    expect(
      schema.safeParse({ environmentId: "env_00000000-0000-4000-a000-000000000000" }).success,
    ).toBe(false);
    expect(schema.safeParse({ environmentId: "runner-1", fresh: true }).success).toBe(false);
  });

  it("keeps both Trigger tool input schemas union-free", () => {
    for (const name of ["trigger_read", "trigger_write"] as const) {
      const json = JSON.stringify(
        z.toJSONSchema(tool("trigger", name).inputSchema, { io: "input", target: "draft-7" }),
      );
      expect(json).not.toContain('"anyOf"');
      expect(json).not.toContain('"oneOf"');
    }
  });

  it("requires an explicit thread message delivery policy", () => {
    const schema = tool("main", "thread_message").inputSchema;
    const base = {
      message: "A self-contained update",
      threadId: "thr_00000000-0000-4000-a000-000000000000",
    };

    expect(schema.safeParse(base).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "report" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "queue" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "steer" }).success).toBe(true);
    expect(schema.safeParse({ ...base, delivery: "trigger" }).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "turn" }).success).toBe(false);
    expect(schema.safeParse({ ...base, delivery: "notify" }).success).toBe(false);
  });

  it("tells every agent how to notify the person while keeping reports passive", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      const description = tool(profileId, "thread_message").description;
      expect(description).toContain(
        '"report" leaves passive context for that Thread\'s next turn; it starts no work and never alerts the person.',
      );
      expect(description).toContain("Use person_notify");
      expect(description).not.toMatch(/report"? to publish/u);
    }
    const conversation = platformGuideForRun({ capabilityProfileId: "main", role: "conversation" });
    expect(conversation).toContain("That reply is also what notifies them");
    expect(conversation).toContain("A report left here only informs your next turn.");
    expect(platformGuideForRun({ capabilityProfileId: "delegated", role: "work" })).toContain(
      "A report alerts no one",
    );
  });

  it("tells every role that a reply's file links open nothing", () => {
    for (const role of ["conversation", "work"] as const) {
      expect(platformGuideForRun({ capabilityProfileId: "main", role })).toContain(
        "Your replies render as Markdown, and only web and email links open.",
      );
      expect(platformGuideForRun({ capabilityProfileId: "main", role })).toContain(
        "A link to a file opens nothing, so write a file's location as a path in code formatting",
      );
    }
  });

  it("loads the Trigger contract only for program authoring, not timing controls", () => {
    const write = tool("trigger", "trigger_write");
    expect(write.description).toContain(
      "Before writing or changing a program, load opensteer-triggers",
    );
    expect(write.description).not.toContain("Trigger programs execute as Node.js ESM modules");
    const schema = JSON.stringify(write.inputSchema.toJSONSchema({ io: "input" }));
    expect(schema).not.toContain("Trigger programs execute as Node.js ESM modules");
    expect(schema).toContain('"toolContractVersion"');
    for (const action of ["set_status", "set_next_fire", "run", "cancel"]) {
      expect(write.description).toContain(`action "${action}" requires`);
    }
  });

  it("keeps the platform guide bounded and explains Trigger execution", () => {
    expect(new TextEncoder().encode(opensteerPlatformGuide).byteLength).toBeLessThanOrEqual(2_048);
    expect(opensteerPlatformGuide).toContain("runs as Node.js on its anchor Thread's Runner");
    expect(opensteerPlatformGuide).toContain(
      "Load opensteer-triggers before writing or changing a program",
    );
    expect(platformGuideForCapabilityProfile("trigger")).toContain(
      "runs as Node.js on its anchor Thread's Runner",
    );
    expect(opensteerPlatformGuide).toContain(
      "A Request exists only after a request tool returns its requestId.",
    );
    expect(opensteerPlatformGuide).toContain(
      "A pending Request is durable work state, not permission. Do not poll or resubmit it.",
    );
    expect(opensteerPlatformGuide).toContain(
      "Use request_list to inspect visible Requests and request_withdraw only when this Thread no longer needs a Request it originated.",
    );
  });

  it("keeps the profile and tool catalogs complete and duplicate-free", () => {
    expect(agentCapabilityProfiles.map(({ id }) => id)).toEqual(
      AgentCapabilityProfileIdSchema.options,
    );
    expect(new Set(agentCapabilityProfiles.map(({ id }) => id)).size).toBe(
      agentCapabilityProfiles.length,
    );
    expect(new Set(agentToolDefinitions.map(({ id }) => id)).size).toBe(
      agentToolDefinitions.length,
    );
    expect(new Set(agentToolDefinitions.map(({ name }) => name)).size).toBe(
      agentToolDefinitions.length,
    );
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      expect(agentCapabilityProfile(profileId).id).toBe(profileId);
    }
  });

  it("routes known integration access directly instead of requiring discovery", () => {
    for (const id of ["main", "workspace", "delegated"] as const) {
      const instructions = agentCapabilityProfile(id).instructions;
      expect(instructions).toContain(
        "integration_request for a known installed integration's access/setup",
      );
      expect(instructions).not.toContain("use integration_search first");
    }
  });

  it("routes each Run profile to Computer use exactly once", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      const instructions = agentCapabilityProfile(profileId).instructions;
      const cue =
        "To see or operate an app on a person's Mac, or a whole Android phone, write JavaScript in the computer tool (opensteer-computer-use).";
      expect(instructions.split(cue).length - 1).toBe(profileId === "trigger" ? 0 : 1);
      expect(
        skillsForCapabilityProfile(profileId).some(({ name }) => name === "opensteer-computer-use"),
      ).toBe(profileId !== "trigger");
    }
  });

  it("routes each browsing role only to skills and recovery tools it receives", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      const instructions = agentCapabilityProfile(profileId).instructions;
      const tools = toolsForCapabilityProfile(profileId).map(({ name }) => name);
      const skills = skillsForCapabilityProfile(profileId).map(({ name }) => name);
      const browses = tools.includes("browser_session_open");
      expect(instructions.includes("opensteer-browser")).toBe(browses);
      expect(skills.includes("opensteer-browser")).toBe(browses);
      expect(instructions.length).toBeLessThanOrEqual(2_048);
    }
  });
});

function browserAccessInput(): Record<string, unknown> {
  return {
    reason: "The task needs the signed-in account",
    suggestion: { kind: "user_choice" },
  };
}

function tool(
  profileId: (typeof AgentCapabilityProfileIdSchema.options)[number],
  name: (typeof expectedTools)[keyof typeof expectedTools][number],
) {
  const definition = toolsForCapabilityProfile(profileId).find(
    (candidate) => candidate.name === name,
  );
  if (!definition) throw new Error(`Missing ${name} from ${profileId}`);
  return definition;
}

it("validates person notifications and limits them to Run profiles", () => {
  const definition = agentToolDefinitions.find((tool) => tool.name === "person_notify")!;
  for (const message of [
    "Milestone passed.",
    " **Review** https://example.com ",
    "😀".repeat(100),
  ]) {
    expect(definition.inputSchema.parse({ message })).toEqual({ message });
  }
  for (const message of ["", " ", "a".repeat(201), "a\nb", "a\tb", "a\u200db", "\ud800"]) {
    expect(definition.inputSchema.safeParse({ message }).success).toBe(false);
  }
  expect(definition.inputSchema.safeParse({ message: "Ready", userId: "other" }).success).toBe(
    false,
  );
  for (const profile of ["main", "workspace", "delegated"] as const)
    expect(capabilityProfileAllowsTool(profile, "person.notify")).toBe(true);
  expect(capabilityProfileAllowsTool("trigger", "person.notify")).toBe(false);
});
