import { personTaskReader } from "@opensteer/database";
import { TriggerOccurrenceIdSchema, OpensteerError, type UserId } from "@opensteer/core";
import { MAX_WEBHOOK_BODY_BYTES } from "@opensteer/triggers";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { TriggerService } from "./trigger-service.js";
import type { HostAuthenticator } from "../identity/auth.js";
import type { PersonActor } from "../commands/actor.js";
import { WebhookRateLimiter } from "./webhook-rate-limiter.js";
const webhookRouteKeyPattern = /^whk_[A-Za-z0-9_-]{32,64}$/u;
const webhookRetryAfterSeconds = 300;
const maxForwardedHeaders = 100;
const maxForwardedHeaderValueLength = 8 * 1_024;
const strippedWebhookHeaders = new Set([
  "connection",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
export function createTriggerRpcHandlers(
  triggers: TriggerService,
): Pick<HostApiHandlers, "triggers.get" | "triggers.list"> {
  return {
    "triggers.get": async (input, context) => {
      const detail = await triggers.get(
        requireUserId(context),
        input.triggerId,
        25,
        personTaskReader,
      );
      return rpcSuccess(hostApi["triggers.get"].success.parse(detail));
    },
    "triggers.list": async (input, context) =>
      rpcSuccess(
        hostApi["triggers.list"].success.parse({
          // The Automations page groups everything its owner has; the list
          // answers as many as the response carries.
          triggers: await triggers.list(requireUserId(context), {
            limit: 100,
            reader: personTaskReader,
            ...(input.systemRole
              ? {
                  systemRole: input.systemRole,
                }
              : {}),
            ...(input.anchorThreadId
              ? {
                  anchorThreadId: input.anchorThreadId,
                }
              : {}),
          }),
        }),
      ),
  };
}
type TriggerCommand = Extract<
  HostApiCommand,
  {
    readonly type: `trigger.${string}`;
  }
>;
export async function handleTriggerCommand(
  triggers: TriggerService,
  command: TriggerCommand,
  context: HostApiServerContext,
  actor?: PersonActor,
): Promise<HostApiCommandOutput> {
  const ownerId = requireUserId(context);
  // Brief T11: approving an agent's proposal runs the command in the proposing lineage,
  // never lending the person's own authority to what it creates.
  const proposedConnectionId =
    typeof actor?.proposal?.proposedBy?.connectionId === "string"
      ? actor.proposal.proposedBy.connectionId
      : undefined;
  switch (command.type) {
    case "trigger.create":
      return {
        ...(await triggers.create(
          {
            ...command.input,
            idempotencyKey: command.idempotencyKey,
            ownerId,
          },
          null,
          undefined,
          proposedConnectionId,
        )),
        type: command.type,
      };
    case "trigger.update":
      return {
        ...(await triggers.update(
          ownerId,
          {
            expectedRevisionId: command.input.expectedRevisionId,
            ...(command.input.name === undefined
              ? {}
              : {
                  name: command.input.name,
                }),
            ...(command.input.script === undefined
              ? {}
              : {
                  script: command.input.script,
                }),
            ...(command.input.source === undefined
              ? {}
              : {
                  source: command.input.source,
                }),
            triggerId: command.triggerId,
          },
          null,
        )),
        type: command.type,
      };
    case "trigger.status.set":
      return {
        trigger: await triggers.setStatus(
          ownerId,
          {
            status: command.status,
            triggerId: command.triggerId,
          },
          null,
        ),
        type: command.type,
      };
    case "trigger.run":
      return {
        occurrence: await triggers.run(
          ownerId,
          command.triggerId,
          command.payload,
          null,
          command.idempotencyKey,
        ),
        type: command.type,
      };
    case "trigger.cancel":
      return {
        canceledOccurrenceIds: [
          ...(
            await triggers.cancel(
              ownerId,
              {
                ...(command.occurrenceId
                  ? {
                      occurrenceId: command.occurrenceId,
                    }
                  : {}),
                triggerId: command.triggerId,
              },
              null,
            )
          ).canceledOccurrenceIds,
        ],
        type: command.type,
      };
    case "trigger.secrets.set":
      return {
        secretNames: [
          ...(
            await triggers.setSecrets(
              ownerId,
              {
                ...(command.remove === undefined ? {} : { remove: command.remove }),
                ...(command.set === undefined ? {} : { set: command.set }),
                triggerId: command.triggerId,
              },
              null,
            )
          ).secretNames,
        ],
        type: command.type,
      };
  }
}
export function registerTriggerRoutes(
  app: FastifyInstance,
  _authenticator: HostAuthenticator,
  triggers: TriggerService,
  rateLimiter: WebhookRateLimiter = new WebhookRateLimiter(),
): void {
  void app.register(async (webhooks) => {
    // Capture the exact raw request bytes for every content type (for HMAC verification, Y2/Y15)
    // without affecting JSON parsing on any other Host route.
    webhooks.removeAllContentTypeParsers();
    webhooks.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    webhooks.setErrorHandler((error, request, reply) => {
      const statusCode =
        typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? (error as { statusCode: number }).statusCode
          : 500;
      if (statusCode === 413) {
        return reply.status(413).send({
          error: {
            code: "payload_too_large",
            message: "Webhook body exceeds 256 KiB",
          },
        });
      }
      app.log.error(
        { err: error, method: request.method, path: "/hooks/v1/[redacted]" },
        "Webhook ingress failed",
      );
      return reply.status(500).send({
        error: {
          code: "internal",
          message: "Internal server error",
        },
      });
    });
    webhooks.route<{ Params: { readonly routeKey: string } }>({
      bodyLimit: MAX_WEBHOOK_BODY_BYTES,
      logLevel: "silent",
      method: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"],
      url: "/hooks/v1/:routeKey",
      handler: async (request, reply) => {
        const routeKey = request.params.routeKey;
        // Pre-DB in-memory rate limit (T7 / Y3): flooded or unknown hits never touch PostgreSQL.
        const admitted = rateLimiter.consume(request.ip, routeKey);
        if (!admitted.allowed) {
          return reply
            .header("retry-after", String(admitted.retryAfterSeconds))
            .status(429)
            .send({
              error: {
                code: "resource_exhausted",
                message: "Too many webhook requests",
                retryable: true,
              },
            });
        }
        if (!webhookRouteKeyPattern.test(routeKey)) {
          return reply.status(404).send({
            error: {
              code: "not_found",
              message: "Webhook not found",
            },
          });
        }
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        const parsedUrl = new URL(request.url, "http://webhook.local");
        const query = extractWebhookQuery(parsedUrl.searchParams);
        const headers = filteredWebhookHeaders(request.headers);
        let result: Awaited<ReturnType<TriggerService["acceptWebhook"]>>;
        try {
          result = await triggers.acceptWebhook({
            headers,
            method: request.method,
            path: "/hooks/v1",
            payload: null,
            query,
            rawBody,
            routeKey,
          });
        } catch (error) {
          if (error instanceof OpensteerError && error.code === "not_found") {
            return reply.status(404).send({
              error: {
                code: "not_found",
                message: "Webhook not found",
              },
            });
          }
          // A full pending queue (100 waiting, Y11) is backpressure, not a delivery failure.
          if (error instanceof OpensteerError && error.code === "resource_exhausted") {
            return reply
              .header("retry-after", String(webhookRetryAfterSeconds))
              .status(429)
              .send({
                error: {
                  code: error.code,
                  message: error.message,
                  retryable: true,
                },
              });
          }
          app.log.error(
            { err: error, method: request.method, path: "/hooks/v1/[redacted]" },
            "Webhook ingress failed",
          );
          return reply.status(500).send({
            error: {
              code: "internal",
              message: "Internal server error",
            },
          });
        }
        return reply.status(202).send({
          occurrenceId: TriggerOccurrenceIdSchema.parse(result.occurrence.id),
          wasDuplicate: result.wasDuplicate,
        });
      },
    });
  });
}
function requireUserId(context: HostApiServerContext): UserId {
  if (!context.session) {
    throw new OpensteerError({
      code: "unauthorized",
      message: "Authentication required",
    });
  }
  return context.session.user.id;
}
function filteredWebhookHeaders(
  headers: FastifyRequest["headers"],
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  let count = 0;
  for (const [rawName, value] of Object.entries(headers)) {
    if (value === undefined || count >= maxForwardedHeaders) continue;
    const name = rawName.toLowerCase();
    if (
      strippedWebhookHeaders.has(name) ||
      name.startsWith("x-forwarded-") ||
      name.startsWith("x-opensteer-")
    ) {
      continue;
    }
    const text = Array.isArray(value) ? value.join(", ") : value;
    result[name] = text.slice(0, maxForwardedHeaderValueLength);
    count += 1;
  }
  return result;
}
function extractWebhookQuery(
  params: URLSearchParams,
): Readonly<Record<string, string | readonly string[]>> {
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }
  return query;
}
