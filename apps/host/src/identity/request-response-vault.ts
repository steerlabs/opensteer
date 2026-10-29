import type { AesGcmSecretVault } from "@opensteer/access/host";
import {
  RequestResponseSchema,
  type RequestId,
  type RequestResponse,
  type RunId,
  type ThreadId,
} from "@opensteer/core";

export type RequestResponseVault = Pick<AesGcmSecretVault, "fingerprint" | "open" | "seal">;

export async function sealRequestResponse(
  vault: RequestResponseVault,
  response: RequestResponse,
  binding: {
    readonly requestId: RequestId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  },
): Promise<{
  readonly envelope: Buffer;
  readonly keyVersion: number;
  readonly requestFingerprint: string;
}> {
  const payload = { response: JSON.stringify(response) };
  const context = responseEnvelopeContext(binding);
  const sealed = await vault.seal(payload, context);
  const requestFingerprint = await vault.fingerprint(payload, context, sealed.keyVersion);
  return { ...sealed, requestFingerprint };
}

export async function openRequestResponse(
  vault: RequestResponseVault,
  envelope: Buffer,
  binding: {
    readonly requestId: RequestId;
    readonly runId: RunId;
    readonly threadId: ThreadId;
  },
): Promise<RequestResponse> {
  const payload = await vault.open(envelope, responseEnvelopeContext(binding));
  return RequestResponseSchema.parse(JSON.parse(payload.response ?? "null"));
}

function responseEnvelopeContext(binding: {
  readonly requestId: RequestId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}) {
  return {
    binding: binding.runId,
    purpose: "request-response",
    recordId: binding.requestId,
    scope: binding.threadId,
  } as const;
}
