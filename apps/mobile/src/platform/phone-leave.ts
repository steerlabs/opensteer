import { RunnerLeaveRequestSchema, RunnerLeaveResponseSchema } from "@opensteer/protocol";
import type { DeliverLeave, LeaveDelivery } from "../iphone-apps/controller.js";

type LeaveFetch = (
  input: string,
  init: { body: string; headers: Record<string, string>; method: "POST"; redirect: "error" },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

/**
 * Delivers a persisted self-leave to the route the phone's runner was pinned
 * to. It carries no session: the native signature is its only authority.
 */
export function networkLeaveDelivery(fetch: LeaveFetch): DeliverLeave {
  return async (leave): Promise<LeaveDelivery> => {
    const origin = new URL(leave.hostUrl);
    if (origin.protocol !== "https:") return "refused";
    const body = RunnerLeaveRequestSchema.parse({
      deploymentId: leave.deploymentId,
      issuedAt: leave.issuedAt,
      runnerId: leave.runnerId,
      signature: leave.signature,
    });
    let response: Awaited<ReturnType<LeaveFetch>>;
    try {
      response = await fetch(new URL("/v1/runner/leave", origin).toString(), {
        body: JSON.stringify(body),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
        redirect: "error",
      });
    } catch {
      return "unreachable";
    }
    if (response.ok) {
      const parsed = RunnerLeaveResponseSchema.safeParse(await response.json().catch(() => null));
      return parsed.success ? "removed" : "unreachable";
    }
    if (response.status === 404) return "missing";
    if (response.status === 408 || response.status === 429 || response.status >= 500)
      return "unreachable";
    return "refused";
  };
}
