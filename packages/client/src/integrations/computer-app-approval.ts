import {
  LocalMcpSecretValueSchema,
  localMcpLaunchSecrets,
  type IntegrationServerId,
  type LocalMcpSecret,
} from "@opensteer/integration-core";
import { mutationIdempotencyKey, unwrapRpcResult, type HostClient } from "../host/index.js";

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

/** Only transient owner review surfaces may render these details. */
export function computerAppApprovalDetails(review: ComputerAppApprovalReview): string {
  const { request, app } = review;
  if (request.kind === "server" && request.server) {
    // The fields below the details ask for its secrets; their values never appear here.
    const { launch } = request.server;
    const shown = launch.type === "stdio" ? { ...launch, secrets: undefined } : launch;
    return `${request.server.installationTitle} · ${request.server.name}\n\n${JSON.stringify(shown, null, 2)}\n\nThis server runs on the selected computer as its login user.${
      localMcpLaunchSecrets(launch).length > 0
        ? " It receives what you enter below as environment variables."
        : ""
    }`;
  }
  if (request.kind === "policy")
    return "Agents acting for you can see and control new apps on this computer whenever a task needs them, including apps installed later, browsers, Finder, Mail and System Settings and their signed-in accounts. Password managers, terminals and automation tools stay off limits. Existing apps still need your approval for more access. Blocked apps stay blocked.";
  return [
    app?.identity.displayName ?? request.app?.displayName ?? request.definitionId,
    request.access === "read-write" ? "Agents can see and change data." : "Agents can read data.",
    app?.path,
    app?.risk === "elevated"
      ? "This app can reach your files, signed-in accounts or system settings. Agents can use whatever its interface offers."
      : null,
    request.threadTitle,
    request.workspaceName,
    request.reason,
  ]
    .filter(Boolean)
    .join("\n\n");
}
