import { randomUUID } from "node:crypto";
import {
  CloudComputerDesiredResponseSchema,
  CloudComputerCheckResponseSchema,
  cloudComputerCheckPath,
  cloudComputerLeasePath,
  cloudComputerLeaseHeader,
  type CloudComputerCheck,
  type CloudComputerId,
  CloudComputerReportResponseSchema,
  cloudComputerStatusPath,
  cloudComputersDesiredPath,
  type CloudComputerDesired,
  type CloudComputerReport,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { json, RemoteRequestError, request, type HttpOptions } from "./http.js";

export interface AccountApi {
  acquire(signal: AbortSignal): Promise<void>;
  check(id: CloudComputerId, check: CloudComputerCheck, signal: AbortSignal): Promise<boolean>;
  desired(signal: AbortSignal): Promise<readonly CloudComputerDesired[]>;
  report(report: CloudComputerReport, signal: AbortSignal): Promise<boolean>;
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

export function accountClient(
  origin: URL,
  token: WorkloadToken,
  http: HttpOptions,
  holder: string = randomUUID(),
  provider?: "google",
): AccountApi {
  const headers = async (signal: AbortSignal) => ({
    authorization: `Bearer ${await token(signal)}`,
    [cloudComputerLeaseHeader]: holder,
  });
  return {
    async acquire(signal) {
      await request(
        "Account",
        new URL(cloudComputerLeasePath, origin),
        http,
        signal,
        json(z.object({ acquired: z.literal(true) })),
        { method: "POST", body: { holder }, headers: await headers(signal) },
      );
    },
    async check(id, check, signal) {
      return (
        await request(
          "Account",
          new URL(cloudComputerCheckPath(id), origin),
          http,
          signal,
          json(CloudComputerCheckResponseSchema),
          { method: "POST", body: check, headers: await headers(signal) },
        )
      ).allowed;
    },
    async desired(signal) {
      const computers: CloudComputerDesired[] = [];
      let after: CloudComputerId | undefined;
      do {
        const url = new URL(cloudComputersDesiredPath, origin);
        if (after) url.searchParams.set("after", after);
        if (provider) url.searchParams.set("provider", provider);
        const page = await request(
          "Account",
          url,
          http,
          signal,
          json(CloudComputerDesiredResponseSchema),
          { headers: await headers(signal) },
        );
        if (page.next && (page.next <= (after ?? "") || page.next !== page.computers.at(-1)?.id))
          throw new Error("Account returned an invalid Cloud Computer cursor");
        computers.push(...page.computers);
        after = page.next;
      } while (after);
      return computers;
    },
    async report(report, signal) {
      const { recorded } = await request(
        "Account",
        new URL(cloudComputerStatusPath(report.id), origin),
        http,
        signal,
        json(CloudComputerReportResponseSchema),
        {
          method: "POST",
          body: report,
          headers: await headers(signal),
        },
      );
      return recorded;
    },
  };
}
