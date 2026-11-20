import {
  accountCloudComputerBillingPortalPath,
  accountCloudComputerCheckoutPath,
  accountCloudComputersPath,
  CloudComputerBillingUrlResponseSchema,
  CloudComputerBootRequestSchema,
  CloudComputerBootResponseSchema,
  CloudComputerCheckoutRequestSchema,
  CloudComputerDeleteRequestSchema,
  cloudComputerDeleteConfirmation,
  CloudComputerDesiredResponseSchema,
  CloudComputerIdSchema,
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
      throw new ControlPlaneError("forbidden", "Open billing from the Opensteer Account website");
    return principal.accountId;
  }

  app.get(cloudComputersDesiredPath, async (request, reply) => {
    privateResponse(reply);
    await options.verifyProvisioner(request.headers.authorization);
    return CloudComputerDesiredResponseSchema.parse({ computers: await store.desired() });
  });

  app.post(`${provisionerPath}/status`, async (request, reply) => {
    privateResponse(reply);
    await options.verifyProvisioner(request.headers.authorization);
    const { id } = params.parse(request.params);
    const report = CloudComputerReportSchema.parse(request.body);
    if (report.id !== id)
      throw new ControlPlaneError("bad_request", "Cloud Computer report ID does not match the URL");
    if (await store.report(report)) options.kickBootstrap?.();
    return CloudComputerReportResponseSchema.parse({ recorded: true });
  });

  const bootLimit = new BootRateLimit();
  const boot = async (request: FastifyRequest, reply: FastifyReply) => {
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
    const body = CloudComputerBootRequestSchema.safeParse(request.body);
    if (!body.success)
      throw new ControlPlaneError("bad_request", "Invalid Cloud Computer boot request");
    return CloudComputerBootResponseSchema.parse(await store.boot(id, body.data));
  };
  app.post(`${provisionerPath}/boot`, { bodyLimit: 4096 }, boot);
  app.post(`${provisionerPath}/bootstrap`, { bodyLimit: 4096 }, boot);

  app.get(accountCloudComputersPath, async (request, reply) => {
    privateResponse(reply);
    const { accountId } = await read(request);
    return CloudComputerListResponseSchema.parse({
      computers: await store.list(accountId),
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
      throw new ControlPlaneError("bad_request", "Confirm deletion of this Cloud Computer");
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
