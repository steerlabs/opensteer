import {
  accountCloudComputerBillingPortalPath,
  accountCloudComputerCheckoutPath,
  accountCloudComputersPath,
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
  CloudComputerReportResponseSchema,
  CloudComputerReportSchema,
  cloudComputerStripeWebhookPath,
  cloudComputersDesiredPath,
  CloudComputerViewSchema,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import { toWebHeaders } from "../portal/routes.js";
import { ControlPlaneError } from "../server/errors.js";
import type { CloudComputerStore } from "./store.js";
import { decodeStripeEvent, verifyStripeSignature } from "./stripe.js";

export interface CloudComputerRouteOptions {
  readonly store: CloudComputerStore;
  readonly verifyProvisioner: (authorization: string | undefined) => Promise<void>;
  readonly stripeWebhookSecret: string;
  readonly kickBootstrap?: () => void;
}

const params = z.object({ id: CloudComputerIdSchema });
const provisionerPath = "/v1/cloud-computers/:id";
const ownerPath = `${accountCloudComputersPath}/:id`;

export function registerCloudComputerRoutes(
  app: FastifyInstance,
  options: CloudComputerRouteOptions & {
    readonly authenticator: Pick<ControlPlaneAuthenticator, "authenticate">;
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

  app.post(cloudComputerLeasePath, async (request, reply) => {
    privateResponse(reply);
    await options.verifyProvisioner(request.headers.authorization);
    const { holder } = CloudComputerLeaseSchema.parse(request.body);
    if (!(await store.lease(holder, true))) {
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
    const { after, limit } = CloudComputerDesiredPageSchema.parse(request.query);
    return CloudComputerDesiredResponseSchema.parse(await store.desired(after, limit));
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

class BootRateLimit {
  readonly #counts = new Map<string, number>();
  #resetAt = 0;

  allow(id: string, ip: string): boolean {
    const now = Date.now();
    if (now >= this.#resetAt) {
      this.#counts.clear();
      this.#resetAt = now + 60_000;
    }
    const key = `${id}:${ip}`;
    const count = this.#counts.get(key) ?? 0;
    if (count >= 20 || (count === 0 && this.#counts.size >= 20_000)) return false;
    this.#counts.set(key, count + 1);
    return true;
  }
}
