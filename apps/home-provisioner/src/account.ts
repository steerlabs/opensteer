import {
  CloudComputerDesiredResponseSchema,
  CloudComputerReportResponseSchema,
  cloudComputerStatusPath,
  cloudComputersDesiredPath,
  type CloudComputerDesired,
  type CloudComputerReport,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { json, RemoteRequestError, request, type HttpOptions } from "./http.js";

export interface AccountApi {
  desired(signal: AbortSignal): Promise<readonly CloudComputerDesired[]>;
  report(report: CloudComputerReport, signal: AbortSignal): Promise<void>;
}

export function accountRefused(error: unknown): error is RemoteRequestError {
  return (
    error instanceof RemoteRequestError &&
    error.service === "Account" &&
    (error.status === 401 || error.status === 403)
  );
}

type WorkloadToken = (signal: AbortSignal) => Promise<string>;

export function workloadIdentityToken(audience: string, http: HttpOptions): WorkloadToken {
  const url = new URL(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity",
  );
  url.search = new URLSearchParams({ audience, format: "full" }).toString();
  let cached: { token: string; expiresAt: number } | undefined;
  return async (signal) => {
    if (cached && cached.expiresAt - 5 * 60_000 > Date.now()) return cached.token;
    cached = await request(
      "Google metadata",
      url,
      http,
      signal,
      (text) => {
        const token = z
          .string()
          .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
          .max(8192)
          .parse(text.trim());
        const payload = Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8");
        const { exp } = json(z.object({ exp: z.number().int().positive() }))(payload);
        return { token, expiresAt: exp * 1_000 };
      },
      { headers: { "metadata-flavor": "Google" } },
    );
    return cached.token;
  };
}

export function accountClient(origin: URL, token: WorkloadToken, http: HttpOptions): AccountApi {
  return {
    async desired(signal) {
      const { computers } = await request(
        "Account",
        new URL(cloudComputersDesiredPath, origin),
        { ...http, maximumResponseBytes: 64 * 1024 * 1024 },
        signal,
        json(CloudComputerDesiredResponseSchema),
        {
          headers: { authorization: `Bearer ${await token(signal)}` },
        },
      );
      return computers;
    },
    async report(report, signal) {
      await request(
        "Account",
        new URL(cloudComputerStatusPath(report.id), origin),
        http,
        signal,
        json(CloudComputerReportResponseSchema),
        {
          method: "POST",
          body: report,
          headers: { authorization: `Bearer ${await token(signal)}` },
        },
      );
    },
  };
}
