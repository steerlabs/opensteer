import { isLoopbackHostname } from "@opensteer/core";
import {
  DeviceEnrollmentPreviewRequestSchema,
  DeviceEnrollmentPreviewResponseSchema,
  deviceEnrollmentPreviewPath,
  type DeviceEnrollmentPreview,
} from "@opensteer/protocol";
import { runnerHttpTransport, type RunnerTransportPolicy } from "@opensteer/runner-client";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

const maximumPreviewBytes = 8 * 1024;

export class WorkHomeEnrollmentRefused extends Error {}

export async function announceEnrollmentPreview(
  transport: RunnerTransportPolicy,
  enrollmentToken: string,
  signal: AbortSignal,
  print: (message: string) => void,
): Promise<void> {
  if (
    transport.hostOrigin.protocol !== "https:" &&
    !isLoopbackHostname(transport.hostOrigin.hostname)
  )
    return;
  const preview = await readPreview(
    transport,
    enrollmentToken,
    AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
  ).catch(() => null);
  if (!preview?.organizationName || !preview.devices) return;

  const organization = preview.organizationName.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
  if (preview.devices === "cloud-computer-only")
    throw new WorkHomeEnrollmentRefused(
      `${organization} doesn't allow other devices to join this work Home.`,
    );
  print(
    `This device is joining a work Home owned by ${organization}. ${organization} will see that it joined, never what's on it.`,
  );
}

async function readPreview(
  transport: RunnerTransportPolicy,
  enrollmentToken: string,
  signal: AbortSignal,
): Promise<DeviceEnrollmentPreview | null> {
  const { url, ca } = await runnerHttpTransport(transport, deviceEnrollmentPreviewPath);
  const body = JSON.stringify(DeviceEnrollmentPreviewRequestSchema.parse({ enrollmentToken }));
  signal.throwIfAborted();
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const outgoing = request(
      url,
      {
        ca,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        method: "POST",
        signal,
      },
      resolve,
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });

  try {
    if (response.statusCode !== 200) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > maximumPreviewBytes) return null;
      chunks.push(bytes);
    }
    return DeviceEnrollmentPreviewResponseSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString("utf8")),
    );
  } finally {
    response.destroy();
  }
}
