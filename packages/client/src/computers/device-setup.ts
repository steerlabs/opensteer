import { isLoopbackHostname } from "@opensteer/core";
import {
  DeviceEnrollmentPreviewRequestSchema,
  DeviceEnrollmentPreviewResponseSchema,
  deviceEnrollmentPreviewPath,
} from "@opensteer/protocol";
import { readBoundedJson } from "@opensteer/shared/boundedJson";
import type { HostClient } from "../host/client.js";
import { mutationIdempotencyKey } from "../host/host-session-client.js";

export async function cancelDeviceSetup(
  hostClient: Pick<HostClient, "dispatch" | "refresh">,
  enrollmentId: string,
): Promise<"cancelled" | "joined"> {
  const result = await hostClient.dispatch({
    enrollmentId,
    idempotencyKey: mutationIdempotencyKey(`device-setup-cancel:${enrollmentId}`),
    type: "runner.enrollment.retire",
  });
  if (result.type !== "runner.enrollment.retire") throw new Error("Cancelling didn’t finish.");
  await hostClient.refresh();
  return result.state === "consumed" ? "joined" : "cancelled";
}

export async function readDeviceEnrollmentPreview(
  target: { readonly hostUrl: string | URL; readonly enrollmentToken: string },
  options: { readonly fetch?: typeof globalThis.fetch; readonly signal?: AbortSignal } = {},
) {
  const url = new URL(deviceEnrollmentPreviewPath, target.hostUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHostname(url.hostname)))
    throw new Error("A device setup code needs a secure Home address.");
  const response = await (options.fetch ?? globalThis.fetch)(url, {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      DeviceEnrollmentPreviewRequestSchema.parse({ enrollmentToken: target.enrollmentToken }),
    ),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error("Couldn’t check this device setup code.");
  const preview = DeviceEnrollmentPreviewResponseSchema.parse(
    await readBoundedJson(response, {
      maximumBytes: 8 * 1024,
      ...(options.signal ? { signal: options.signal } : {}),
    }),
  );
  const { organizationName, devices } = preview;
  return organizationName !== undefined && devices !== undefined
    ? { organizationName, devices }
    : null;
}
