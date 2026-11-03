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
) {
  const result = await host.dispatch({
    type: "integration.computer.setup.respond",
    setupRequestId,
    decision,
    idempotencyKey: mutationIdempotencyKey(`computer-app-answer:${setupRequestId}`),
  });
  if (result.type !== "integration.computer.setup.respond")
    throw new Error("The approval was not recorded.");
}

/** Only transient owner review surfaces may render these details. */
export function computerAppApprovalDetails(review: ComputerAppApprovalReview): string {
  const { request, app } = review;
  if (request.kind === "server" && request.server)
    return `${request.server.installationTitle} · ${request.server.name}\n\n${JSON.stringify(request.server.launch, null, 2)}\n\nThis server runs on the selected computer as its login user.`;
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
