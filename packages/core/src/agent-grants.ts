import { z } from "zod";
import { ComputerAppBundleIdSchema, ComputerAppTeamIdSchema } from "./computer-app.js";
import { DeviceIdSchema, PhoneDisplayDefinitionIdSchema } from "./devices.js";
import { BrowserProfileIdSchema, BrowserSourceIdSchema } from "./ids.js";
import { ThreadAccessModeSchema, type ThreadAccessMode } from "./models.js";
import type { ResourceAccessLevel } from "./resource-access.js";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const integrationId = (prefix: string) =>
  z
    .string()
    .regex(new RegExp(`^${prefix}_${uuid}$`, "i"))
    .transform((value) => value.toLowerCase());

export const agentGrantMaxResources = 64;

/** Who may act through a plugin grant; the tagged kind is the identity boundary. */
export const AgentGrantPluginTargetSchema = z.discriminatedUnion("kind", [
  /** An installed plugin, by its stable package key. */
  z.strictObject({ kind: z.literal("installed"), pluginId: z.string().min(1).max(200) }),
  /** One local MCP server. */
  z.strictObject({ kind: z.literal("local-server"), serverId: integrationId("isv") }),
  /** One device data account, such as Calendar on one phone. */
  z.strictObject({
    kind: z.literal("device-account"),
    integrationConnectionId: integrationId("con"),
  }),
]);
export type AgentGrantPluginTarget = z.infer<typeof AgentGrantPluginTargetSchema>;

/**
 * What a granted app is: a Mac app pinned to its bundle id and signer (`null` is
 * an explicitly unsigned app), or one phone screen by its display definition.
 */
export const AgentGrantAppIdentitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("mac-app"),
    bundleId: ComputerAppBundleIdSchema.transform((value) => value.toLowerCase()),
    teamId: ComputerAppTeamIdSchema.nullable(),
  }),
  z.strictObject({ kind: z.literal("phone-screen"), definitionId: PhoneDisplayDefinitionIdSchema }),
]);
export type AgentGrantAppIdentity = z.infer<typeof AgentGrantAppIdentitySchema>;

export const AgentGrantResourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("browser-profile"), profileId: BrowserProfileIdSchema }),
  z.strictObject({ kind: z.literal("chrome-tabs"), sourceId: BrowserSourceIdSchema }),
  /** The exact owner approval row on one Device, and the app it approved. */
  z.strictObject({
    kind: z.literal("computer-app"),
    approvalId: integrationId("con"),
    deviceId: DeviceIdSchema,
    app: AgentGrantAppIdentitySchema,
  }),
  z.strictObject({
    kind: z.literal("plugin"),
    target: AgentGrantPluginTargetSchema,
    access: z.enum(["read", "read-write"]),
  }),
]);
export type AgentGrantResource = z.infer<typeof AgentGrantResourceSchema>;

const AgentGrantInputSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("everything") }),
  z.strictObject({
    scope: z.literal("selected"),
    tasks: z.boolean(),
    resources: z.array(AgentGrantResourceSchema).max(agentGrantMaxResources),
  }),
]);

export type AgentGrant =
  | { readonly scope: "everything" }
  | {
      readonly scope: "selected";
      readonly tasks: boolean;
      readonly resources: readonly AgentGrantResource[];
    };
/** One validated value: resources deduplicated by identity (widest access kept) and sorted. */
export const AgentGrantSchema: z.ZodType<AgentGrant, unknown> =
  AgentGrantInputSchema.transform(canonicalAgentGrant);
export const AgentGrantPluginTargetViewSchema = z.discriminatedUnion("kind", [
  z.object(AgentGrantPluginTargetSchema.options[0].shape),
  z.object(AgentGrantPluginTargetSchema.options[1].shape),
  z.object(AgentGrantPluginTargetSchema.options[2].shape),
]);
export const AgentGrantAppIdentityViewSchema = z.discriminatedUnion("kind", [
  z.object(AgentGrantAppIdentitySchema.options[0].shape),
  z.object(AgentGrantAppIdentitySchema.options[1].shape),
]);
const [browserProfileGrant, chromeTabsGrant, appGrant, pluginGrant] =
  AgentGrantResourceSchema.options;
const AgentGrantResourceViewSchema = z.discriminatedUnion("kind", [
  z.object(browserProfileGrant.shape),
  z.object(chromeTabsGrant.shape),
  z.object({ ...appGrant.shape, app: AgentGrantAppIdentityViewSchema }),
  z.object({ ...pluginGrant.shape, target: AgentGrantPluginTargetViewSchema }),
]);
const [everythingGrant, selectedGrant] = AgentGrantInputSchema.options;
export const AgentGrantViewSchema: z.ZodType<AgentGrant, unknown> = z
  .discriminatedUnion("scope", [
    z.object(everythingGrant.shape),
    z.object({
      ...selectedGrant.shape,
      resources: z.array(AgentGrantResourceViewSchema).max(agentGrantMaxResources),
    }),
  ])
  .transform(canonicalAgentGrant);

export const everythingAgentGrant: AgentGrant = Object.freeze({ scope: "everything" });

export function agentGrantResourceKey(resource: AgentGrantResource): string {
  switch (resource.kind) {
    case "browser-profile":
      return `browser-profile:${resource.profileId}`;
    case "chrome-tabs":
      return `chrome-tabs:${resource.sourceId}`;
    case "computer-app":
      return `computer-app:${resource.approvalId}`;
    case "plugin":
      return `plugin:${agentGrantPluginTargetKey(resource.target)}`;
  }
}
export function agentGrantPluginTargetKey(target: AgentGrantPluginTarget): string {
  switch (target.kind) {
    case "installed":
      return `installed:${target.pluginId}`;
    case "local-server":
      return `local-server:${target.serverId}`;
    case "device-account":
      return `device-account:${target.integrationConnectionId}`;
  }
}

function canonicalAgentGrant(
  grant: z.output<typeof AgentGrantInputSchema>,
  context: z.RefinementCtx,
): AgentGrant {
  if (grant.scope === "everything") return { scope: "everything" };
  const byKey = new Map<string, AgentGrantResource>();
  for (const resource of grant.resources) {
    const key = agentGrantResourceKey(resource);
    const held = byKey.get(key);
    // Two different statements about one resource are refused, never merged.
    if (held && JSON.stringify(held) !== JSON.stringify(resource))
      context.addIssue({
        code: "custom",
        message: `The grant names ${key} twice with different terms`,
        path: ["resources"],
      });
    else if (!held) byKey.set(key, resource);
  }
  return {
    scope: "selected",
    tasks: grant.tasks,
    resources: [...byKey.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, resource]) => resource),
  };
}

/** A concrete thing an effect touches, as the Home resolved it at use time. */
export type AgentGrantTarget =
  | { readonly kind: "browser-profile"; readonly profileId: string }
  | { readonly kind: "chrome-tabs"; readonly sourceId: string }
  | {
      readonly kind: "computer-app";
      readonly approvalId: string;
      readonly deviceId: string;
      readonly app:
        | { readonly kind: "mac-app"; readonly bundleId: string; readonly teamId: string | null }
        | { readonly kind: "phone-screen"; readonly definitionId: string };
    }
  | { readonly kind: "plugin"; readonly target: AgentGrantPluginTarget }
  /** Remote Device files, shells, forwarding and mini-apps: no selected resource grants them. */
  | { readonly kind: "device" };

/**
 * The grant's ceiling for one target: `read-write` for `everything`, the
 * granted level for a matching resource, and null otherwise. A target whose
 * identity changed (another signer, a new approval row) does not match.
 */
export function agentGrantAccess(
  grant: AgentGrant,
  target: AgentGrantTarget,
): ResourceAccessLevel | null {
  if (grant.scope === "everything") return "read-write";
  for (const resource of grant.resources) {
    if (target.kind === "browser-profile" && resource.kind === "browser-profile") {
      if (resource.profileId === target.profileId) return "read-write";
    } else if (target.kind === "chrome-tabs" && resource.kind === "chrome-tabs") {
      if (resource.sourceId === target.sourceId) return "read-write";
    } else if (target.kind === "computer-app" && resource.kind === "computer-app") {
      if (
        resource.approvalId === target.approvalId.toLowerCase() &&
        resource.deviceId === target.deviceId &&
        sameApp(resource.app, target.app)
      )
        return "read-write";
    } else if (target.kind === "plugin" && resource.kind === "plugin") {
      if (agentGrantPluginTargetKey(resource.target) === pluginTargetKey(target.target))
        return resource.access;
    }
  }
  return null;
}
function pluginTargetKey(target: AgentGrantPluginTarget): string {
  const parsed = AgentGrantPluginTargetSchema.safeParse(target);
  return parsed.success ? agentGrantPluginTargetKey(parsed.data) : "";
}
function sameApp(
  granted: AgentGrantAppIdentity,
  current: Extract<AgentGrantTarget, { kind: "computer-app" }>["app"],
): boolean {
  if (granted.kind === "phone-screen")
    return current.kind === "phone-screen" && current.definitionId === granted.definitionId;
  return (
    current.kind === "mac-app" &&
    current.bundleId.toLowerCase() === granted.bundleId &&
    current.teamId === granted.teamId
  );
}

export function agentGrantAllows(
  grant: AgentGrant,
  target: AgentGrantTarget,
  level: ResourceAccessLevel,
): boolean {
  const access = agentGrantAccess(grant, target);
  return access !== null && (level === "read" || access === "read-write");
}

export function agentGrantAllowsTasks(grant: AgentGrant): boolean {
  return grant.scope === "everything" || grant.tasks;
}

/** Tool families a grant implies; settings also need `full-access`, which the caller checks. */
export type AgentGrantToolFamily = "tasks" | "browser" | "computer" | "plugins" | "settings";
export function agentGrantToolFamilies(grant: AgentGrant): ReadonlySet<AgentGrantToolFamily> {
  if (grant.scope === "everything")
    return new Set(["tasks", "browser", "computer", "plugins", "settings"]);
  const families = new Set<AgentGrantToolFamily>();
  if (grant.tasks) families.add("tasks");
  for (const resource of grant.resources)
    families.add(
      resource.kind === "browser-profile" || resource.kind === "chrome-tabs"
        ? "browser"
        : resource.kind === "computer-app"
          ? "computer"
          : "plugins",
    );
  return families;
}

/** Whether `after` withdraws anything `before` allowed. */
export function agentGrantNarrowed(before: AgentGrant, after: AgentGrant): boolean {
  if (after.scope === "everything") return false;
  if (before.scope === "everything") return true;
  if (before.tasks && !after.tasks) return true;
  return before.resources.some((resource) => {
    const kept = after.resources.find(
      (candidate) => agentGrantResourceKey(candidate) === agentGrantResourceKey(resource),
    );
    if (!kept) return true;
    if (resource.kind === "plugin" && kept.kind === "plugin")
      return resource.access === "read-write" && kept.access === "read";
    // Any other change to one approval's terms (another Device or signer) withdraws the original.
    return JSON.stringify(kept) !== JSON.stringify(resource);
  });
}

export function minThreadAccessMode(
  ...modes: readonly (ThreadAccessMode | null | undefined)[]
): ThreadAccessMode {
  const present = modes.filter((mode): mode is ThreadAccessMode => Boolean(mode));
  if (!present.length) throw new Error("minThreadAccessMode needs at least one mode");
  return present.reduce((lowest, mode) =>
    ThreadAccessModeSchema.options.indexOf(mode) < ThreadAccessModeSchema.options.indexOf(lowest)
      ? mode
      : lowest,
  );
}

/**
 * What a chat's grant may contain, the one rule (the Home refuses by it, sends it with each chat,
 * and the screens offer only it): Tasks always, since a chat can only ask your own agents to
 * work; where anyone in its one channel may speak, only Tasks and the plugins chosen; otherwise
 * everything a connected agent may hold.
 */
export interface ChatGrantShape {
  readonly everything: boolean;
  readonly resources: readonly AgentGrantResource["kind"][];
  readonly tasks: "required";
}
export function chatGrantShape(senders: "owner" | "anyone"): ChatGrantShape {
  return senders === "anyone"
    ? { everything: false, resources: ["plugin"], tasks: "required" }
    : {
        everything: true,
        resources: ["browser-profile", "chrome-tabs", "computer-app", "plugin"],
        tasks: "required",
      };
}
/** Why a chat may not hold this grant, in the Home's words; null when it may. */
export function chatGrantRefusal(
  shape: ChatGrantShape,
  grant: AgentGrant,
): {
  readonly reason: "bridge-needs-tasks" | "bridge-anyone-grant";
  readonly message: string;
} | null {
  if (grant.scope === "selected" && !grant.tasks)
    return {
      reason: "bridge-needs-tasks",
      message: "A chat can only ask your own agents to work, so it always needs tasks.",
    };
  if (
    (grant.scope === "everything" && !shape.everything) ||
    (grant.scope === "selected" &&
      grant.resources.some((resource) => !shape.resources.includes(resource.kind)))
  )
    return {
      reason: "bridge-anyone-grant",
      message:
        "When anyone in the conversation can message it, it can use only tasks and the plugins you choose.",
    };
  return null;
}
