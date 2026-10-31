import { TriggerOccurrenceIdSchema, OpensteerError, type UserId } from "@opensteer/core";
import {
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { TriggerService } from "./trigger-service.js";
import type { HostAuthenticator } from "../identity/auth.js";

const WebhookParamsSchema = z.strictObject({
  routeKey: z.string().regex(/^wh_[A-Za-z0-9_-]{32}$/),
});
const webhookRetryAfterSeconds = 300;

export function createTriggerRpcHandlers(
  triggers: TriggerService,
): Pick<HostApiHandlers, "triggers.get" | "triggers.list"> {
  return {
    "triggers.get": async (input, context) => {
      const detail = await triggers.get(requireUserId(context), input.triggerId, 25, {
        kind: "user",
      });
      return rpcSuccess(hostApi["triggers.get"].success.parse(detail));
    },
    "triggers.list": async (input, context) =>
      rpcSuccess(
        hostApi["triggers.list"].success.parse({
          // The Automations page groups everything its owner has; the list
          // answers as many as the response carries.
          triggers: await triggers.list(
            requireUserId(context),
            {
              limit: 100,
              ...(input.anchorThreadId ? { anchorThreadId: input.anchorThreadId } : {}),
              ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
            },
            { kind: "user" },
          ),
        }),
      ),
  };
}

type TriggerCommand = Extract<HostApiCommand, { readonly type: `trigger.${string}` }>;

export async function handleTriggerCommand(
  triggers: TriggerService,
  command: TriggerCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const ownerId = requireUserId(context);
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
        )),
        type: command.type,
      };
    case "trigger.update":
      return {
        ...(await triggers.update(
          ownerId,
          {
            expectedRevisionId: command.input.expectedRevisionId,
            ...(command.input.name === undefined ? {} : { name: command.input.name }),
            ...(command.input.program === undefined ? {} : { program: command.input.program }),
            ...(command.input.source === undefined ? {} : { source: command.input.source }),
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
        occurrence: await triggers.run(ownerId, command.triggerId, command.payload, null),
        type: command.type,
      };
    case "trigger.cancel":
      return {
        canceledOccurrenceIds: [
          ...(
            await triggers.cancel(
              ownerId,
              {
                ...(command.occurrenceId ? { occurrenceId: command.occurrenceId } : {}),
                triggerId: command.triggerId,
              },
              null,
            )
          ).canceledOccurrenceIds,
        ],
        type: command.type,
      };
  }
}

export function registerTriggerRoutes(
  app: FastifyInstance,
  _authenticator: HostAuthenticator,
  triggers: TriggerService,
): void {
  app.post("/hooks/v1/:routeKey", async (request, reply) => {
    const { routeKey } = WebhookParamsSchema.parse(request.params);
    const secret = bearerToken(request.headers.authorization);
    const headers = selectedWebhookHeaders(request.headers);
    const deliveryId = webhookDeliveryId(headers);
    let result: Awaited<ReturnType<TriggerService["acceptWebhook"]>>;
    try {
      result = await triggers.acceptWebhook({
        ...(deliveryId ? { deliveryId } : {}),
        headers,
        method: request.method,
        payload: normalizeWebhookPayload(request.body, request.headers["content-type"]),
        routeKey,
        secret,
      });
    } catch (error) {
      // A full pending queue is backpressure, not a delivery failure: the
      // sender's own retry is the overflow buffer this Trigger needs.
      if (!(error instanceof OpensteerError) || error.code !== "resource_exhausted") throw error;
      return reply
        .header("retry-after", String(webhookRetryAfterSeconds))
        .status(429)
        .send({ error: { code: error.code, message: error.message, retryable: true } });
    }
    return reply.status(202).send({
      occurrenceId: TriggerOccurrenceIdSchema.parse(result.occurrence.id),
      wasDuplicate: result.wasDuplicate,
    });
  });
}

function requireUserId(context: HostApiServerContext): UserId {
  if (!context.session) {
    throw new OpensteerError({ code: "unauthorized", message: "Authentication required" });
  }
  return context.session.user.id;
}

function bearerToken(value: string | undefined): string {
  const match = /^Bearer ([^\s]{20,4096})$/u.exec(value ?? "");
  if (!match?.[1]) {
    throw new OpensteerError({ code: "not_found", message: "Webhook not found" });
  }
  return match[1];
}

function selectedWebhookHeaders(
  headers: FastifyRequest["headers"],
): Readonly<Record<string, string>> {
  const allowed = new Set([
    "content-type",
    "user-agent",
    "webhook-id",
    "x-github-delivery",
    "x-github-event",
    "x-gitlab-event",
    "x-gitlab-event-uuid",
    "x-request-id",
    "x-webhook-id",
  ]);
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) => {
      if (!allowed.has(name) || value === undefined) return [];
      return [[name, Array.isArray(value) ? value.join(",") : value]];
    }),
  );
}

function webhookDeliveryId(headers: Readonly<Record<string, string>>): string | undefined {
  return (
    headers["x-github-delivery"] ??
    headers["x-gitlab-event-uuid"] ??
    headers["webhook-id"] ??
    headers["x-webhook-id"] ??
    headers["x-request-id"]
  )?.slice(0, 512);
}

function normalizeWebhookPayload(body: unknown, contentType: string | undefined): unknown {
  if (!Buffer.isBuffer(body)) return body ?? null;
  const mediaType =
    contentType?.split(";", 1)[0]?.trim().toLowerCase() ?? "application/octet-stream";
  if (mediaType.startsWith("text/") || mediaType === "application/x-www-form-urlencoded") {
    return body.toString("utf8");
  }
  return { contentType: mediaType, data: body.toString("base64"), encoding: "base64" };
}
