import type { ComputerAppIdentity } from "@opensteer/protocol";
import {
  LocalMcpSecretValueSchema,
  localMcpLaunchSecrets,
  type IntegrationServerId,
  type LocalMcpSecret,
} from "@opensteer/integration-core";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "../host/index.js";
import { invalidateComputerSetupRequests } from "./computer-setup-requests.js";

export async function reviewComputerAppApproval(
  host: Pick<HostClient, "rpc">,
  setupRequestId: string,
  signal?: AbortSignal,
) {
  return unwrapRpcResult(
    await host.rpc["integration.computer.setup.review"](
      { setupRequestId },
      signal ? { signal } : undefined,
    ),
  );
}
export type ComputerAppApprovalReview = Awaited<ReturnType<typeof reviewComputerAppApproval>>;

export async function respondComputerAppApproval(
  host: Pick<HostClient, "dispatch">,
  setupRequestId: string,
  decision: "allow" | "deny",
  secrets: Readonly<Record<string, string>> = {},
) {
  const result = await host.dispatch({
    type: "integration.computer.setup.respond",
    setupRequestId,
    decision,
    ...(decision === "allow" && Object.keys(secrets).length > 0 ? { secrets: { ...secrets } } : {}),
    idempotencyKey: mutationIdempotencyKey(`computer-app-answer:${setupRequestId}`),
  });
  if (result.type !== "integration.computer.setup.respond")
    throw new Error("The approval was not recorded.");
  invalidateComputerSetupRequests(host);
}

/** One secret an MCP server asks its computer's owner for, as a form shows it. */
export interface LocalMcpSecretField extends LocalMcpSecret {
  /** A value is stored, which leaving the field blank keeps. */
  readonly saved: boolean;
}

/** The secrets a server's approval asks for; none for every other approval. */
export function computerAppApprovalSecretFields(
  review: ComputerAppApprovalReview,
): readonly LocalMcpSecretField[] {
  const launch = review.request.kind === "server" ? review.request.server?.launch : undefined;
  if (!launch) return [];
  const saved = new Set(review.savedSecrets ?? []);
  return localMcpLaunchSecrets(launch).map((secret) => ({
    ...secret,
    saved: saved.has(secret.name),
  }));
}

/**
 * What to send for a form's secrets: each entered value, by name. A blank
 * field keeps a saved value and is otherwise the first problem to show.
 */
export function localMcpSecretsToSend(
  fields: readonly LocalMcpSecretField[],
  entered: Readonly<Record<string, string>>,
):
  | { readonly ok: true; readonly secrets: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly message: string } {
  const secrets: Record<string, string> = {};
  for (const field of fields) {
    const value = entered[field.name] ?? "";
    if (value === "") {
      if (field.saved) continue;
      return { ok: false, message: `Enter ${field.title}.` };
    }
    const parsed = LocalMcpSecretValueSchema.safeParse(value);
    if (!parsed.success)
      return {
        ok: false,
        message: `${field.title}: ${parsed.error.issues[0]?.message ?? "Invalid value"}`,
      };
    secrets[field.name] = value;
  }
  return { ok: true, secrets };
}

/** The plugin servers on this person's computers whose secrets they can change. */
export async function localMcpSecretServers(host: Pick<HostClient, "rpc">) {
  return unwrapRpcResult(await host.rpc["integration.server.secrets.list"]({})).servers;
}
export type LocalMcpSecretServer = Awaited<ReturnType<typeof localMcpSecretServers>>[number];

/** Gives some of an approved server's secrets new values; the others keep theirs. */
export async function setLocalMcpServerSecrets(
  host: Pick<HostClient, "dispatch">,
  serverId: IntegrationServerId,
  secrets: Readonly<Record<string, string>>,
) {
  const result = await host.dispatch({
    type: "integration.server.secrets.set",
    serverId,
    secrets: { ...secrets },
    idempotencyKey: mutationIdempotencyKey(`server-secrets:${serverId}`),
  });
  if (result.type !== "integration.server.secrets.set")
    throw new Error("The secrets were not saved.");
}

/** One thing an approval lets agents do, or keeps from them. */
export interface ComputerAppApprovalAbility {
  readonly allowed: boolean;
  readonly text: string;
}

/**
 * An approval as every surface shows it: what it is for, what agents may then
 * do, and the technical facts folded away. Only transient owner review
 * surfaces may render it.
 */
export interface ComputerAppApprovalView {
  /** What stands for it: the app's own icon, a plugin, or every app. */
  readonly mark: "app" | "apps" | "plugin";
  /** The question, naming what is approved. */
  readonly title: string;
  readonly name: string;
  /** Which computer, where there are several, and why it was asked. */
  readonly context: string | null;
  /** A Mac app, whose own icon marks it. */
  readonly app: ComputerAppIdentity | null;
  readonly runnerId: string;
  readonly abilities: readonly ComputerAppApprovalAbility[];
  readonly warning: string | null;
  readonly details: { readonly label: string; readonly text: string } | null;
}

export function computerAppApprovalView(
  review: ComputerAppApprovalReview,
  /** The computer it is on, where the person has more than one to tell apart. */
  computerName: string | null = null,
): ComputerAppApprovalView {
  const { request, app } = review;
  const on = computerName ? `on ${computerName}` : "on this computer";
  const why = request.reason ?? (request.threadTitle ? `For “${request.threadTitle}”` : null);
  const base = {
    context: [computerName ? `On ${computerName}` : null, why].filter(Boolean).join(" · ") || null,
    runnerId: request.runnerId,
  };
  if (request.kind === "policy")
    return {
      ...base,
      mark: "apps",
      title: "Allow apps automatically?",
      name: "Any app",
      app: null,
      abilities: [
        { allowed: true, text: "Use any app a task needs, including new ones" },
        { allowed: false, text: "Never password managers or terminals" },
        { allowed: false, text: "Apps you limited or blocked stay that way" },
      ],
      warning: "This includes browsers, Mail and System Settings, signed in as you.",
      details: null,
    };
  if (request.kind === "server" && request.server) {
    const { launch } = request.server;
    const name = review.name ?? request.server.installationTitle;
    // The fields below the review ask for its secrets; their values never appear here.
    return {
      ...base,
      mark: "plugin",
      title: `Allow ${name}?`,
      name,
      app: null,
      abilities: [
        { allowed: true, text: `Runs ${on} as you` },
        ...(localMcpLaunchSecrets(launch).length > 0
          ? [{ allowed: true, text: "Gets the keys you enter below" }]
          : []),
      ],
      warning: null,
      details: {
        label: "How it runs",
        text:
          launch.type === "stdio"
            ? [
                [launch.command, ...launch.args].join(" "),
                `in ${launch.cwd}`,
                ...Object.entries(launch.env).map(([key, value]) => `${key}=${value}`),
              ].join("\n")
            : [
                launch.url,
                ...Object.entries(launch.headers).map(([key, value]) => `${key}: ${value}`),
              ].join("\n"),
      },
    };
  }
  const identity = app?.identity ?? request.app;
  const name = review.name ?? identity?.displayName ?? request.definitionId;
  const writes = request.access === "read-write";
  // A Mac app is used through its window; any other app through its data.
  const mac = identity !== null;
  return {
    ...base,
    mark: identity ? "app" : "apps",
    title: `Allow ${name}?`,
    name,
    app: identity,
    abilities: [
      { allowed: true, text: mac ? "See what’s on screen" : "Read its data" },
      writes
        ? { allowed: true, text: mac ? "Click, type and make changes" : "Add and change things" }
        : { allowed: false, text: "No changes" },
    ],
    warning:
      app?.risk === "elevated" ? "It can reach your files, signed-in accounts or settings." : null,
    details: app ? { label: "Details", text: app.path } : null,
  };
}
