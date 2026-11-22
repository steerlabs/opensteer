import {
  accountCloudComputerBillingPortalPath,
  accountCloudComputerCheckoutPath,
  accountCloudComputersPath,
  BrowserPoolHostBootCompleteRequestSchema,
  BrowserPoolHostBootCompleteResponseSchema,
  BrowserPoolHostBootRequestSchema,
  BrowserPoolHostBootResponseSchema,
  BrowserPoolHostCheckSchema,
  BrowserPoolHostDesiredPageSchema,
  BrowserPoolHostDesiredResponseSchema,
  BrowserPoolHostIdSchema,
  BrowserPoolHostReplaceUnreadyRequestSchema,
  BrowserPoolHostReplaceUnreadyResponseSchema,
  BrowserPoolHostReportSchema,
  BrowserPoolSlotBumpTermRequestSchema,
  BrowserPoolSlotBumpTermResponseSchema,
  BrowserPoolSlotCheckSchema,
  BrowserPoolSlotDesiredPageSchema,
  BrowserPoolSlotDesiredResponseSchema,
  BrowserPoolSlotIdSchema,
  BrowserPoolSlotReportSchema,
  browserPoolHostsDesiredPath,
  browserPoolSlotsDesiredPath,
  CloudComputerBackupReportSchema,
  CloudComputerBillingUrlResponseSchema,
  CloudComputerBootRequestSchema,
  CloudComputerBootCompleteRequestSchema,
  CloudComputerBootCompleteResponseSchema,
  CloudComputerCheckSchema,
  CloudComputerCheckResponseSchema,
  CloudComputerLeaseSchema,
  cloudComputerLeasePath,
  cloudComputerLeaseHeader,
  CloudComputerBootResponseSchema,
  CloudComputerCheckoutRequestSchema,
  CloudComputerDeleteRequestSchema,
  cloudComputerDeleteConfirmation,
  CloudComputerDesiredResponseSchema,
  CloudComputerDesiredPageSchema,
  CloudComputerIdSchema,
  CloudComputerEgressResponseSchema,
  CloudComputerListResponseSchema,
  CloudComputerOfferResponseSchema,
  cloudComputerOfferPath,
  CloudComputerReportResponseSchema,
  CloudComputerReportSchema,
  cloudComputerStripeWebhookPath,
  cloudComputersDesiredPath,
  CloudComputerViewSchema,
  ManagedBrowserPoolRegistrationRequestSchema,
  ManagedBrowserPoolTargetResponseSchema,
  managedBrowserPoolRegistrationPath,
  managedBrowserPoolTargetPath,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import type { ControlPlaneStore } from "../database/store.js";
import { toWebHeaders } from "../portal/routes.js";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerStore } from "./store.js";
import { decodeStripeEvent, verifyStripeSignature } from "./stripe.js";

export interface CloudComputerRouteOptions {
  readonly store: CloudComputerStore;
  readonly verifyProvisioner: (authorization: string | undefined) => Promise<void>;
  readonly stripeWebhookSecret: string;
  readonly kickBootstrap?: () => void;
  /** Asks the billing pass to run now rather than at its next turn, best effort. */
  readonly kickBilling?: () => void;
  /** The Opensteer website, the one origin allowed to read the public offer from a page. */
  readonly websiteOrigin?: URL;
}

const params = z.object({ id: CloudComputerIdSchema });
const poolHostParams = z.object({ id: BrowserPoolHostIdSchema });
const poolSlotParams = z.object({ slotId: BrowserPoolSlotIdSchema });
const provisionerPath = "/v1/cloud-computers/:id";
const poolHostPath = "/v1/browser-pool/hosts/:id";
const poolSlotPath = "/v1/browser-pool/slots/:slotId";
const ownerPath = `${accountCloudComputersPath}/:id`;

export function registerCloudComputerRoutes(
  app: FastifyInstance,
  options: CloudComputerRouteOptions & {
    readonly authenticator: Pick<ControlPlaneAuthenticator, "authenticate">;
    readonly authenticateHostCredential?: Pick<
      ControlPlaneStore,
      "authenticateHostCredential"
    >["authenticateHostCredential"];
  },
): void {
  const { store, authenticator } = options;
  const read = (request: FastifyRequest) =>
    authenticator.authenticate(toWebHeaders(request.headers), { scope: "deployments:read" });
  const write = (request: FastifyRequest) =>
    authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:write",
      mutation: true,
    });
  async function browser(request: FastifyRequest) {
    const principal = await write(request);
    if (principal.kind !== "session")
      throw new ControlPlaneError("forbidden", "Open billing from the Opensteer Account website", {
        reason: "cloud-computer-billing-web-only",
      });
    return principal.accountId;
  }

  async function requireLease(request: FastifyRequest) {
    await options.verifyProvisioner(request.headers.authorization);
    const lease = CloudComputerLeaseSchema.safeParse({
      holder: request.headers[cloudComputerLeaseHeader],
    });
    if (!lease.success || !(await store.lease(lease.data.holder, false))) {
      throw new ControlPlaneError("forbidden", "Cloud Computer provisioner lease is not held");
    }
  }

  // Public and read-only: the same answer for everyone, read without cookies or credentials,
  // so a cache may keep it. A page may read it only from the Opensteer website.
  app.get(cloudComputerOfferPath, async (request, reply) => {
    void reply.header("cache-control", "public, max-age=300");
    void reply.header("vary", "Origin");
    const website = options.websiteOrigin?.origin;
    if (website !== undefined && request.headers.origin === website)
      void reply.header("access-control-allow-origin", website);
    return CloudComputerOfferResponseSchema.parse({ plan: store.offer });
  });

  app.post(cloudComputerLeasePath, async (request, reply) => {
    privateResponse(reply);
    await options.verifyProvisioner(request.headers.authorization);
    const { holder, poolConfigured } = CloudComputerLeaseSchema.parse(request.body);
    if (!(await store.lease(holder, true, poolConfigured))) {
      throw new ControlPlaneError("conflict", "Another Cloud Computer provisioner holds the lease");
    }
    return { acquired: true };
  });
  app.post(`${provisionerPath}/check`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { id } = params.parse(request.params);
    return CloudComputerCheckResponseSchema.parse({
      allowed: await store.check(id, CloudComputerCheckSchema.parse(request.body)),
    });
  });

  app.get(cloudComputersDesiredPath, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { after, limit, provider } = CloudComputerDesiredPageSchema.parse(request.query);
    return CloudComputerDesiredResponseSchema.parse(await store.desired(after, limit, provider));
  });

  app.post(`${provisionerPath}/status`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { id } = params.parse(request.params);
    const report = CloudComputerReportSchema.parse(request.body);
    if (report.id !== id)
      throw new ControlPlaneError("bad_request", "Cloud Computer report ID does not match the URL");
    const result = await store.report(report);
    if (result.kick) options.kickBootstrap?.();
    return CloudComputerReportResponseSchema.parse({ recorded: result.recorded });
  });

  const bootLimit = new BootRateLimit();
  for (const action of ["boot", "boot-complete"] as const)
    app.post(`${provisionerPath}/${action}`, { bodyLimit: 4096 }, async (request, reply) => {
      privateResponse(reply);
      const { id } = params.parse(request.params);
      if (!bootLimit.allow(id, request.ip)) {
        return reply
          .code(429)
          .header("retry-after", "60")
          .send({
            error: { code: "rate_limited", message: "Too many Cloud Computer boot requests" },
          });
      }
      if (action === "boot-complete") {
        const body = CloudComputerBootCompleteRequestSchema.parse(request.body);
        await store.bootComplete(id, body);
        return CloudComputerBootCompleteResponseSchema.parse({ completed: true });
      }
      const body = CloudComputerBootRequestSchema.safeParse(request.body);
      if (!body.success)
        throw new ControlPlaneError("bad_request", "Invalid Cloud Computer boot request");
      return CloudComputerBootResponseSchema.parse(await store.boot(id, body.data));
    });

  const egressLimit = new BootRateLimit();
  app.get(`${provisionerPath}/egress`, async (request, reply) => {
    privateResponse(reply);
    const { id } = params.parse(request.params);
    if (!egressLimit.allow(id, request.ip))
      return reply
        .code(429)
        .header("retry-after", "60")
        .send({
          error: { code: "rate_limited", message: "Too many Cloud Computer egress requests" },
        });
    return CloudComputerEgressResponseSchema.parse(
      await store.egressForHome(id, request.headers.authorization),
    );
  });

  app.post(`${provisionerPath}/backup`, { bodyLimit: 1024 }, async (request, reply) => {
    privateResponse(reply);
    const { id } = params.parse(request.params);
    await store.reportBackupForHome(
      id,
      request.headers.authorization,
      CloudComputerBackupReportSchema.parse(request.body),
    );
    return reply.code(204).send();
  });

  // --- Browser pool provisioner routes (hosts + slots) ---
  app.get(browserPoolHostsDesiredPath, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { after, limit } = BrowserPoolHostDesiredPageSchema.parse(request.query);
    return BrowserPoolHostDesiredResponseSchema.parse(await store.desiredPoolHosts(after, limit));
  });

  app.post(`${poolHostPath}/check`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { id } = poolHostParams.parse(request.params);
    return CloudComputerCheckResponseSchema.parse({
      allowed: await store.checkPoolHost(id, BrowserPoolHostCheckSchema.parse(request.body)),
    });
  });

  app.post(`${poolHostPath}/status`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { id } = poolHostParams.parse(request.params);
    const report = BrowserPoolHostReportSchema.parse(request.body);
    if (report.id !== id) {
      throw new ControlPlaneError("bad_request", "Pool host report ID does not match the URL");
    }
    return CloudComputerReportResponseSchema.parse(await store.reportPoolHost(report));
  });

  // T8: Provisioner replaces an unenrolled host that missed its readiness window (at most twice).
  app.post(`${poolHostPath}/replace-unready`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { id } = poolHostParams.parse(request.params);
    return BrowserPoolHostReplaceUnreadyResponseSchema.parse(
      await store.replaceUnenrolledPoolHost(
        id,
        BrowserPoolHostReplaceUnreadyRequestSchema.parse(request.body),
      ),
    );
  });

  const poolHostBootLimit = new BootRateLimit();
  for (const action of ["boot", "boot-complete"] as const) {
    app.post(`${poolHostPath}/${action}`, { bodyLimit: 4096 }, async (request, reply) => {
      privateResponse(reply);
      const { id } = poolHostParams.parse(request.params);
      if (!poolHostBootLimit.allow(id, request.ip)) {
        return reply
          .code(429)
          .header("retry-after", "60")
          .send({
            error: { code: "rate_limited", message: "Too many pool host boot requests" },
          });
      }
      if (action === "boot-complete") {
        const body = BrowserPoolHostBootCompleteRequestSchema.parse(request.body);
        await store.bootCompletePoolHost(id, body);
        return BrowserPoolHostBootCompleteResponseSchema.parse({ completed: true });
      }
      const body = BrowserPoolHostBootRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw new ControlPlaneError("bad_request", "Invalid pool host boot request");
      }
      return BrowserPoolHostBootResponseSchema.parse(await store.bootPoolHost(id, body.data));
    });
  }

  // S4 + T9: Pool host slot-egress pull (rate-limited per host and slot; uniform refusal).
  // Cold-start pulls run on every browser start/wake, so allow 30/min per (host, slot) while stopping floods.
  const poolHostEgressLimit = new BootRateLimit(browserPoolHostSlotEgressRateLimitPerMinute);
  app.post(`${poolHostPath}/slot-egress`, { bodyLimit: 4096 }, async (request, reply) => {
    privateResponse(reply);
    const rawHostId = String((request.params as { id?: unknown })?.id ?? "");
    const rawBody = request.body as { slotId?: unknown } | undefined;
    const rawSlotId = typeof rawBody?.slotId === "string" ? rawBody.slotId : "";
    const limitKey = rawSlotId ? `${rawHostId}:${rawSlotId}` : rawHostId;
    if (!poolHostEgressLimit.allow(limitKey, request.ip)) {
      return reply
        .code(429)
        .header("retry-after", "60")
        .send({
          error: { code: "rate_limited", message: "Too many pool host egress requests" },
        });
    }
    return CloudComputerEgressResponseSchema.parse(
      await store.egressForPoolHost(rawHostId, request.body),
    );
  });

  app.get(browserPoolSlotsDesiredPath, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { after, limit } = BrowserPoolSlotDesiredPageSchema.parse(request.query);
    return BrowserPoolSlotDesiredResponseSchema.parse(await store.desiredPoolSlots(after, limit));
  });

  app.post(`${poolSlotPath}/check`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { slotId } = poolSlotParams.parse(request.params);
    return CloudComputerCheckResponseSchema.parse({
      allowed: await store.checkPoolSlot(slotId, BrowserPoolSlotCheckSchema.parse(request.body)),
    });
  });

  app.post(`${poolSlotPath}/bump-term`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { slotId } = poolSlotParams.parse(request.params);
    return BrowserPoolSlotBumpTermResponseSchema.parse(
      await store.bumpPoolSlotTerm(
        slotId,
        BrowserPoolSlotBumpTermRequestSchema.parse(request.body),
      ),
    );
  });

  app.post(`${poolSlotPath}/status`, async (request, reply) => {
    privateResponse(reply);
    await requireLease(request);
    const { slotId } = poolSlotParams.parse(request.params);
    const report = BrowserPoolSlotReportSchema.parse(request.body);
    if (report.slotId !== slotId) {
      throw new ControlPlaneError("bad_request", "Pool slot report ID does not match the URL");
    }
    return CloudComputerReportResponseSchema.parse(await store.reportPoolSlot(report));
  });

  // W4 + S5: Pooled Home key registration and target lookup (Host bearer credential + pinned key signature).
  const requireHomeHost = async (request: FastifyRequest) => {
    if (!options.authenticateHostCredential) {
      throw new ControlPlaneError("unavailable", "Host credential verification is unavailable");
    }
    const header = request.headers.authorization;
    return options.authenticateHostCredential(typeof header === "string" ? header : header?.[0]);
  };

  app.put(managedBrowserPoolRegistrationPath, { bodyLimit: 8192 }, async (request, reply) => {
    privateResponse(reply);
    const authority = await requireHomeHost(request);
    const body = ManagedBrowserPoolRegistrationRequestSchema.parse(request.body);
    return ManagedBrowserPoolTargetResponseSchema.parse(
      await store.registerHomeBrowserPoolKeys(authority.deploymentId, body),
    );
  });

  app.get(managedBrowserPoolTargetPath, async (request, reply) => {
    privateResponse(reply);
    const authority = await requireHomeHost(request);
    return ManagedBrowserPoolTargetResponseSchema.parse(
      await store.browserPoolTargetForHome(authority.deploymentId),
    );
  });

  app.get(accountCloudComputersPath, async (request, reply) => {
    privateResponse(reply);
    const { accountId } = await read(request);
    return CloudComputerListResponseSchema.parse({
      computers: await store.listForAccount(accountId),
      plan: store.plan,
    });
  });
  app.get(ownerPath, async (request, reply) => {
    privateResponse(reply);
    const { accountId } = await read(request);
    return CloudComputerViewSchema.parse(
      await store.show(params.parse(request.params).id, accountId),
    );
  });
  app.post(accountCloudComputerCheckoutPath, async (request, reply) => {
    privateResponse(reply);
    const accountId = await browser(request);
    const { requestId } = CloudComputerCheckoutRequestSchema.parse(request.body);
    return CloudComputerBillingUrlResponseSchema.parse(await store.checkout(accountId, requestId));
  });
  app.post(accountCloudComputerBillingPortalPath, async (request, reply) => {
    privateResponse(reply);
    return CloudComputerBillingUrlResponseSchema.parse(
      await store.billingPortal(await browser(request)),
    );
  });
  for (const action of ["suspend", "resume"] as const) {
    app.post(`${ownerPath}/${action}`, async (request, reply) => {
      privateResponse(reply);
      const { accountId } = await write(request);
      return CloudComputerViewSchema.parse(
        await store.mutate(params.parse(request.params).id, action, accountId),
      );
    });
  }
  app.delete(ownerPath, async (request, reply) => {
    privateResponse(reply);
    const { accountId } = await write(request);
    const { id } = params.parse(request.params);
    const { confirmation } = CloudComputerDeleteRequestSchema.parse(request.body);
    if (confirmation !== cloudComputerDeleteConfirmation(id)) {
      throw new ControlPlaneError("bad_request", "Confirm deletion of this Cloud Computer", {
        reason: "cloud-computer-delete-confirmation-required",
      });
    }
    return CloudComputerViewSchema.parse(await store.mutate(id, "delete", accountId));
  });

  void app.register((scope, _registrationOptions, done) => {
    scope.removeContentTypeParser("application/json");
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, next) =>
      next(null, body),
    );
    scope.post(cloudComputerStripeWebhookPath, async (request, reply) => {
      privateResponse(reply);
      const signature = request.headers["stripe-signature"];
      const body = request.body;
      if (
        !Buffer.isBuffer(body) ||
        typeof signature !== "string" ||
        !verifyStripeSignature(body, signature, options.stripeWebhookSecret)
      ) {
        throw new ControlPlaneError("unauthorized", "Invalid Stripe signature");
      }
      await store.applyStripeEvent(decodeStripeEvent(body));
      return { received: true };
    });
    done();
  });
}

function privateResponse(reply: FastifyReply) {
  void reply.header("cache-control", "no-store");
}

export const browserPoolHostSlotEgressRateLimitPerMinute = 30;

class BootRateLimit {
  readonly #counts = new Map<string, number>();
  #resetAt = 0;

  readonly #maxPerMinute: number;

  constructor(maxPerMinute = 20) {
    this.#maxPerMinute = maxPerMinute;
  }

  allow(id: string, ip: string): boolean {
    const now = Date.now();
    if (now >= this.#resetAt) {
      this.#counts.clear();
      this.#resetAt = now + 60_000;
    }
    const key = `${id}:${ip}`;
    const count = this.#counts.get(key) ?? 0;
    if (count >= this.#maxPerMinute || (count === 0 && this.#counts.size >= 20_000)) return false;
    this.#counts.set(key, count + 1);
    return true;
  }
}
