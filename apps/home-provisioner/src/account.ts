import { randomUUID } from "node:crypto";
import {
  BrowserPoolHostDesiredResponseSchema,
  BrowserPoolHostReplaceUnreadyResponseSchema,
  BrowserPoolSlotBumpTermResponseSchema,
  BrowserPoolSlotDesiredResponseSchema,
  browserPoolHostCheckPath,
  browserPoolHostReplaceUnreadyPath,
  browserPoolHostStatusPath,
  browserPoolHostsDesiredPath,
  browserPoolSlotBumpTermPath,
  browserPoolSlotCheckPath,
  browserPoolSlotStatusPath,
  browserPoolSlotsDesiredPath,
  CloudComputerDesiredResponseSchema,
  CloudComputerCheckResponseSchema,
  cloudComputerCheckPath,
  cloudComputerLeasePath,
  cloudComputerLeaseHeader,
  type BrowserPoolHostCheck,
  type BrowserPoolHostDesired,
  type BrowserPoolHostId,
  type BrowserPoolHostReplaceUnreadyRequest,
  type BrowserPoolHostReplaceUnreadyResponse,
  type BrowserPoolHostReport,
  type BrowserPoolSlotBumpTermRequest,
  type BrowserPoolSlotBumpTermResponse,
  type BrowserPoolSlotCheck,
  type BrowserPoolSlotDesired,
  type BrowserPoolSlotId,
  type BrowserPoolSlotReport,
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

export interface PoolAccountApi {
  desiredHosts(signal: AbortSignal): Promise<readonly BrowserPoolHostDesired[]>;
  checkHost(
    id: BrowserPoolHostId,
    check: BrowserPoolHostCheck,
    signal: AbortSignal,
  ): Promise<boolean>;
  reportHost(report: BrowserPoolHostReport, signal: AbortSignal): Promise<boolean>;
  replaceUnenrolledHost(
    id: BrowserPoolHostId,
    input: BrowserPoolHostReplaceUnreadyRequest,
    signal: AbortSignal,
  ): Promise<BrowserPoolHostReplaceUnreadyResponse>;
  desiredSlots(signal: AbortSignal): Promise<readonly BrowserPoolSlotDesired[]>;
  checkSlot(
    slotId: BrowserPoolSlotId,
    check: BrowserPoolSlotCheck,
    signal: AbortSignal,
  ): Promise<boolean>;
  bumpSlotTerm(
    slotId: BrowserPoolSlotId,
    input: BrowserPoolSlotBumpTermRequest,
    signal: AbortSignal,
  ): Promise<BrowserPoolSlotBumpTermResponse>;
  reportSlot(report: BrowserPoolSlotReport, signal: AbortSignal): Promise<boolean>;
}

export interface AccountApi {
  acquire(signal: AbortSignal): Promise<void>;
  /** Gives the lease back, as its holder; false when it held none. */
  release?(signal: AbortSignal): Promise<boolean>;
  check(id: CloudComputerId, check: CloudComputerCheck, signal: AbortSignal): Promise<boolean>;
  desired(signal: AbortSignal): Promise<readonly CloudComputerDesired[]>;
  report(report: CloudComputerReport, signal: AbortSignal): Promise<boolean>;
  readonly pool?: PoolAccountApi;
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
  /** The subnet it creates Homes and pool hosts in, which each Home's firewall may reach. */
  poolNetwork?: string,
  /** Its admin port on every pool host, which the account refuses if Homes use it. */
  poolAdminPort?: number,
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
        {
          method: "POST",
          body: {
            holder,
            ...(poolNetwork !== undefined ? { poolNetwork } : {}),
            ...(poolAdminPort !== undefined ? { poolAdminPort } : {}),
          },
          headers: await headers(signal),
        },
      );
    },
    async release(signal) {
      const { released } = await request(
        "Account",
        new URL(cloudComputerLeasePath, origin),
        http,
        signal,
        json(z.object({ released: z.boolean() })),
        { method: "DELETE", headers: await headers(signal) },
      );
      return released;
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
    pool: {
      async desiredHosts(signal) {
        const hosts: BrowserPoolHostDesired[] = [];
        let after: BrowserPoolHostId | undefined;
        do {
          const url = new URL(browserPoolHostsDesiredPath, origin);
          if (after) url.searchParams.set("after", after);
          const page = await request(
            "Account",
            url,
            http,
            signal,
            json(BrowserPoolHostDesiredResponseSchema),
            { headers: await headers(signal) },
          );
          if (page.next && (page.next <= (after ?? "") || page.next !== page.hosts.at(-1)?.id)) {
            throw new Error("Account returned an invalid browser pool host cursor");
          }
          hosts.push(...page.hosts);
          after = page.next;
        } while (after);
        return hosts;
      },
      async checkHost(id, check, signal) {
        return (
          await request(
            "Account",
            new URL(browserPoolHostCheckPath(id), origin),
            http,
            signal,
            json(CloudComputerCheckResponseSchema),
            { method: "POST", body: check, headers: await headers(signal) },
          )
        ).allowed;
      },
      async reportHost(report, signal) {
        return (
          await request(
            "Account",
            new URL(browserPoolHostStatusPath(report.id), origin),
            http,
            signal,
            json(CloudComputerReportResponseSchema),
            { method: "POST", body: report, headers: await headers(signal) },
          )
        ).recorded;
      },
      async replaceUnenrolledHost(id, input, signal) {
        return request(
          "Account",
          new URL(browserPoolHostReplaceUnreadyPath(id), origin),
          http,
          signal,
          json(BrowserPoolHostReplaceUnreadyResponseSchema),
          { method: "POST", body: input, headers: await headers(signal) },
        );
      },
      async desiredSlots(signal) {
        const slots: BrowserPoolSlotDesired[] = [];
        let after: BrowserPoolSlotId | undefined;
        do {
          const url = new URL(browserPoolSlotsDesiredPath, origin);
          if (after) url.searchParams.set("after", after);
          const page = await request(
            "Account",
            url,
            http,
            signal,
            json(BrowserPoolSlotDesiredResponseSchema),
            { headers: await headers(signal) },
          );
          if (
            page.next &&
            (page.next <= (after ?? "") || page.next !== page.slots.at(-1)?.slotId)
          ) {
            throw new Error("Account returned an invalid browser pool slot cursor");
          }
          slots.push(...page.slots);
          after = page.next;
        } while (after);
        return slots;
      },
      async checkSlot(slotId, check, signal) {
        return (
          await request(
            "Account",
            new URL(browserPoolSlotCheckPath(slotId), origin),
            http,
            signal,
            json(CloudComputerCheckResponseSchema),
            { method: "POST", body: check, headers: await headers(signal) },
          )
        ).allowed;
      },
      async bumpSlotTerm(slotId, input, signal) {
        return request(
          "Account",
          new URL(browserPoolSlotBumpTermPath(slotId), origin),
          http,
          signal,
          json(BrowserPoolSlotBumpTermResponseSchema),
          { method: "POST", body: input, headers: await headers(signal) },
        );
      },
      async reportSlot(report, signal) {
        return (
          await request(
            "Account",
            new URL(browserPoolSlotStatusPath(report.slotId), origin),
            http,
            signal,
            json(CloudComputerReportResponseSchema),
            { method: "POST", body: report, headers: await headers(signal) },
          )
        ).recorded;
      },
    },
  };
}
