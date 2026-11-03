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
    "app_publish",
    "app_list",
    "app_fetch",
    "request_list",
    "request_withdraw",
    "environment_list",
    "plugin_install",
    "thread_read",
    "thread_list",
    "thread_delegate",
    "assignment_cancel",
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
  specialist: [
    "app_publish",
    "app_list",
    "app_fetch",
    "request_list",
    "request_withdraw",
    "environment_list",
    "thread_read",
    "thread_list",
    "assignment_cancel",
    "thread_message",
    "thread_write",
    "browser_profile_list",
    "sign_in",
    "browser_tab_read",
    "browser_tab_write",
    "browser_session_list",
    "browser_session_open",
    "trigger_read",
  ],
  main: [
    "app_publish",
    "app_list",
    "app_fetch",
    "request_list",
    "request_withdraw",
    "environment_list",
    "project_list",
    "project_create",
    "plugin_install",
    "thread_read",
    "thread_list",
    "thread_delegate",
    "assignment_cancel",
    "person_message",
    "person_show",
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
    "project_list",
    "project_create",
    "thread_read",
    "thread_delegate",
    "thread_message",
    "trigger_read",
    "trigger_write",
  ],
  workspace: [
    "app_publish",
    "app_list",
    "app_fetch",
    "request_list",
    "request_withdraw",
    "environment_list",
    "plugin_install",
    "thread_read",
    "thread_list",
    "thread_delegate",
    "assignment_cancel",
    "person_message",
    "person_show",
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
  it("accepts the current Run place without caller-supplied native identities", () => {
    const schema = tool("main", "person_show").inputSchema;
    expect(schema.parse({ target: { current: true } })).toEqual({ target: { current: true } });
    expect(schema.safeParse({ target: { current: false } }).success).toBe(false);
    expect(schema.safeParse({ target: { current: true, tabId: "another-tab" } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({
        target: { place: { kind: "phone", machineId: "arbitrary", display: "main" } },
      }).success,
    ).toBe(false);
  });
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
    expect(main.description).toContain("target Project's workspaceId");
    expect(main.description).toContain("specialist bindings");
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

  it("routes delegated updates through the parent while keeping reports passive", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      const description = tool(profileId, "thread_message").description;
      expect(description).toContain(
        "report saves context without starting work or alerting the person",
      );
      expect(description).toContain("Task updates go to the assigning Thread");
      expect(description).not.toMatch(/report"? to publish/u);
      expect(description).toContain("Accepted does not mean read");
      expect(description).toContain("cancelled means it will not run");
    }
    const conversation = platformGuideForRun({ capabilityProfileId: "main", role: "conversation" });
    expect(conversation).toContain("without any assistant text");
    expect(conversation).toContain("deliver awaited results");
    expect(platformGuideForRun({ capabilityProfileId: "delegated", role: "work" })).toContain(
      "report leaves context for its next turn",
    );
  });

  it("tells every role that a reply's file links open nothing", () => {
    for (const role of ["conversation", "work"] as const) {
      expect(platformGuideForRun({ capabilityProfileId: "main", role })).toContain(
        "Web and email links open; local file links do not.",
      );
      expect(platformGuideForRun({ capabilityProfileId: "main", role })).toContain(
        "Write file locations as code",
      );
    }
  });

  it("loads the Trigger contract only for program authoring, not timing controls", () => {
    const write = tool("trigger", "trigger_write");
    expect(write.description).toContain(
      "Before writing or changing a program, load opensteer:triggers",
    );
    expect(write.description).not.toContain("Trigger programs execute as Node.js ESM modules");
    const schema = JSON.stringify(write.inputSchema.toJSONSchema({ io: "input" }));
    expect(schema).not.toContain("Trigger programs execute as Node.js ESM modules");
    expect(schema).toContain('"toolContractVersion"');
    for (const requirement of [
      "Timing controls require anchor access no higher than yours",
      "archiving require full access",
      "set_status needs triggerId and status",
      "set_next_fire needs triggerId and future ISO nextFireAt",
      "run needs a non-archived schedule/webhook triggerId",
      "cancel needs triggerId and optional occurrenceId",
      "Started work keeps running",
    ]) {
      expect(write.description).toContain(requirement);
    }
  });

  it("keeps the platform guide bounded and explains Trigger execution", () => {
    expect(new TextEncoder().encode(opensteerPlatformGuide).byteLength).toBeLessThanOrEqual(2_048);
    expect(opensteerPlatformGuide).toContain("run Node.js on their anchor Thread's Runner");
    expect(opensteerPlatformGuide).toContain(
      "read opensteer:triggers before writing or changing a program",
    );
    expect(platformGuideForCapabilityProfile("trigger")).toContain(
      "run Node.js on their anchor Thread's Runner",
    );
    expect(opensteerPlatformGuide).toContain(
      "A Request exists only when a request tool returns requestId.",
    );
    expect(opensteerPlatformGuide).toContain("Pending is not permission:");
    expect(opensteerPlatformGuide).toContain(
      "Use request_list to inspect Requests and request_withdraw only for one this Thread originated and no longer needs.",
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
    for (const id of ["main", "workspace"] as const) {
      const instructions = agentCapabilityProfile(id).instructions;
      expect(instructions).toContain("integration_request handles known access or setup");
      expect(instructions).not.toContain("use integration_search first");
    }
  });

  it("explains delegated sign-in authority without offering new approvals", () => {
    const instructions = agentCapabilityProfile("delegated").instructions;
    expect(instructions).toContain("sign_in for already-authorized sites");
    expect(instructions).toContain("cannot open new sign-in approvals");
    expect(instructions).toContain("needs-approval");
    expect(instructions).toContain("withdraw one this Thread originated");
    expect(instructions).not.toContain("integration_request handles");
  });

  it("names the history cursor input", () => {
    for (const name of ["thread_read", "thread_list", "project_list"] as const) {
      expect(tool("main", name).description).toContain("window.nextBefore as before");
    }
    expect(
      tool("main", "thread_read").inputSchema.safeParse({
        threadId: "thr_00000000-0000-4000-8000-000000000001",
        before: "opaque",
      }).success,
    ).toBe(true);
  });

  it("routes each Run profile to Computer use exactly once", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      const instructions = agentCapabilityProfile(profileId).instructions;
      const cue =
        "For Mac app interfaces or Android phones, read opensteer:computer-use and use the computer tool.";
      expect(instructions.split(cue).length - 1).toBe(profileId === "trigger" ? 0 : 1);
      expect(
        skillsForCapabilityProfile(profileId).some(({ name }) => name === "opensteer:computer-use"),
      ).toBe(profileId !== "trigger");
    }
  });

  it("routes each browsing role only to skills and recovery tools it receives", () => {
    for (const profileId of AgentCapabilityProfileIdSchema.options) {
      const instructions = agentCapabilityProfile(profileId).instructions;
      const tools = toolsForCapabilityProfile(profileId).map(({ name }) => name);
      const skills = skillsForCapabilityProfile(profileId).map(({ name }) => name);
      const browses = tools.includes("browser_session_open");
      expect(instructions.includes("opensteer:browser")).toBe(browses);
      expect(skills.includes("opensteer:browser")).toBe(browses);
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

it("validates person messages and limits them to Run profiles", () => {
  const definition = agentToolDefinitions.find((tool) => tool.name === "person_message")!;
  for (const message of [
    "Milestone passed.",
    " **Review** https://example.com ",
    "😀".repeat(100),
    "a\nb",
    "a\tb",
    "a\u200db",
    "a".repeat(2000),
  ]) {
    expect(definition.inputSchema.parse({ message })).toEqual({ message: message.trim() });
  }
  for (const message of ["", " ", "a".repeat(2001), "\ud800", "a\u0000b"]) {
    expect(definition.inputSchema.safeParse({ message }).success).toBe(false);
  }
  expect(definition.inputSchema.safeParse({ message: "Ready", userId: "other" }).success).toBe(
    false,
  );
  for (const profile of ["main", "workspace"] as const)
    expect(capabilityProfileAllowsTool(profile, "person.message")).toBe(true);
  expect(capabilityProfileAllowsTool("delegated", "person.message")).toBe(false);
  expect(capabilityProfileAllowsTool("delegated", "person.show")).toBe(false);
  expect(capabilityProfileAllowsTool("trigger", "person.message")).toBe(false);
});

it("specialists cannot delegate, install plugins, author triggers or request access", () => {
  for (const tool of [
    "thread.delegate",
    "plugin.install",
    "trigger.write",
    "browser.profile.create",
    "browser.access.request",
    "machine.full-disk-access.request",
  ] as const) {
    expect(capabilityProfileAllowsTool("specialist", tool)).toBe(false);
  }
});
