import { OpensteerError, isLoopbackHostname, type UserId } from "@opensteer/core";
import {
  BrowserSourcePairChallengeResultSchema,
  BrowserSourcePairInputSchema,
  BrowserSourcePairResultSchema,
  type BrowserSourcePairing,
  hostApi,
  rpcSuccess,
  type HostApiCommand,
  type HostApiCommandOutput,
  type HostApiHandlers,
  type HostApiServerContext,
} from "@opensteer/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  browserSourceInvitationSigningBytes,
  encodeBrowserSourceInvitation,
  type BrowserSourceInvitationDocument,
  type HostDiscoveryEnvelope,
  type PersonalHostAccessRouteEnvelope,
} from "@opensteer/deployment-authority";
import type { BrowserSourceService } from "../browser/browser-source-service.js";
import { exchangeRouteOrigin } from "../access/session-exchange-routes.js";
import { hostInternalRoutePaths } from "./internal-routes.js";

export interface BrowserSourceRpcOptions {
  readonly service: BrowserSourceService;
  readonly canonicalOrigin: string;
  readonly authority: HostDiscoveryEnvelope;
  /** Personal Deployments offer Chrome on the same Mac the loopback origin too. */
  readonly personal: boolean;
  readonly deploymentName: () => Promise<string>;
  readonly currentRoute: () => Promise<PersonalHostAccessRouteEnvelope | null>;
  readonly signInvitation: (bytes: Uint8Array) => string;
}

export function createBrowserSourceRpcHandlers(
  options: BrowserSourceRpcOptions,
): Pick<HostApiHandlers, "browser.sources.get" | "browser.sources.inspect"> {
  return {
    "browser.sources.get": async (_input, context) =>
      rpcSuccess(
        hostApi["browser.sources.get"].success.parse(
          await options.service.listState({ ownerId: requireOwner(context) }),
        ),
      ),
    "browser.sources.inspect": async (input, context) =>
      rpcSuccess(
        hostApi["browser.sources.inspect"].success.parse(
          await options.service.inspect({ ownerId: requireOwner(context), url: input.url }),
        ),
      ),
  };
}

export type BrowserSourceCommand = Extract<
  HostApiCommand,
  {
    readonly type:
      | `browser.source.${string}`
      | "browser.site.remove"
      | "browser.session.sign-in"
      | "browser.sign-in.respond"
      | "browser.password-sign-in.decline";
  }
>;

export function isBrowserSourceCommand(command: HostApiCommand): command is BrowserSourceCommand {
  return (
    command.type.startsWith("browser.source.") ||
    command.type === "browser.site.remove" ||
    command.type === "browser.session.sign-in" ||
    command.type === "browser.sign-in.respond" ||
    command.type === "browser.password-sign-in.decline"
  );
}

export async function handleBrowserSourceCommand(
  options: BrowserSourceRpcOptions,
  command: BrowserSourceCommand,
  context: HostApiServerContext,
): Promise<HostApiCommandOutput> {
  const ownerId = requireOwner(context);
  switch (command.type) {
    case "browser.source.pair":
      return { type: command.type, pairing: await createPairing(options, ownerId) };
    case "browser.source.rename":
      await options.service.renameSource({
        ownerId,
        sourceId: command.sourceId,
        name: command.name,
      });
      return { type: command.type };
    case "browser.source.revoke":
      await options.service.revokeSource({ ownerId, sourceId: command.sourceId });
      return { type: command.type };
    case "browser.site.remove":
      await options.service.removeSite({
        ownerId,
        site: command.site,
        workspaceId: command.workspaceId,
      });
      return { type: command.type };
    case "browser.session.sign-in":
      return {
        type: command.type,
        outcome: await options.service.sessionSignIn({
          idempotencyKey: command.idempotencyKey,
          ownerId,
          ...(command.surfaceId ? { surfaceId: command.surfaceId } : {}),
          sessionId: command.sessionId,
          sourceId: command.sourceId,
          url: command.url,
        }),
      };
    case "browser.sign-in.respond":
      return {
        type: command.type,
        outcome: await options.service.respond({
          decision: command.decision,
          ownerId,
          requestId: command.requestId,
        }),
      };
    case "browser.password-sign-in.decline": {
      const status = await options.service.declinePasswordSignIn({
        ownerId,
        requestId: command.requestId,
      });
      return { type: command.type, status };
    }
  }
}

/**
 * One signed, one-use invitation. A Personal Deployment reachable on loopback
 * lists that origin first (Chrome on the same Mac) and its remote route second
 * (Chrome elsewhere); the extension keeps the first one whose identity matches.
 */
async function createPairing(
  options: BrowserSourceRpcOptions,
  ownerId: UserId,
): Promise<BrowserSourcePairing> {
  const loopback = isLoopbackHostname(new URL(options.canonicalOrigin).hostname);
  const route = options.personal && loopback ? await options.currentRoute() : null;
  const pairing = await options.service.createPairing({ ownerId, route });
  const document: BrowserSourceInvitationDocument = {
    version: 2,
    destinations: [
      { origin: options.canonicalOrigin, route: null },
      ...(route ? [{ origin: route.document.route.origin, route }] : []),
    ],
    deploymentName: await options.deploymentName(),
    code: pairing.code,
    expiresAt: pairing.expiresAt,
    authority: options.authority,
  };
  return {
    destinations: document.destinations.map((destination) => ({
      origin: destination.origin,
      remote: destination.route !== null,
    })),
    expiresAt: pairing.expiresAt,
    invitation: encodeBrowserSourceInvitation({
      ...document,
      signature: options.signInvitation(browserSourceInvitationSigningBytes(document)),
    }),
  };
}

/** Source credentials authorize this wire only; they are never client or Run credentials. */
export function registerBrowserSourceWire(
  app: FastifyInstance,
  service: BrowserSourceService,
  canonicalOrigin: string,
): void {
  for (const path of [
    hostInternalRoutePaths.browserSourcePair,
    hostInternalRoutePaths.browserSourcePairChallenge,
  ]) {
    app.options(path, async (request, reply) => {
      if (!setBrowserSourceExtensionCors(reply, request.headers.origin)) {
        return reply.status(403).send();
      }
      return reply
        .header("access-control-allow-methods", "POST, OPTIONS")
        .header("access-control-allow-headers", "content-type")
        .status(204)
        .send();
    });
  }
  app.post(
    hostInternalRoutePaths.browserSourcePairChallenge,
    { bodyLimit: 1_024 },
    async (request, reply) => {
      if (!setBrowserSourceExtensionCors(reply, request.headers.origin))
        return reply.status(403).send();
      void reply.header("cache-control", "no-store");
      return BrowserSourcePairChallengeResultSchema.parse(
        await service.pairChallenge(
          request.body,
          browserSourceIngressOrigin(request, canonicalOrigin),
          request.raw.socket.remoteAddress ?? "unknown",
        ),
      );
    },
  );
  app.post(
    hostInternalRoutePaths.browserSourcePair,
    { bodyLimit: 4_096 },
    async (request, reply) => {
      if (!setBrowserSourceExtensionCors(reply, request.headers.origin))
        return reply.status(403).send();
      void reply.header("cache-control", "no-store");
      return BrowserSourcePairResultSchema.parse(
        await service.pair(
          BrowserSourcePairInputSchema.parse(request.body),
          browserSourceIngressOrigin(request, canonicalOrigin),
        ),
      );
    },
  );
  app.get(hostInternalRoutePaths.browserSourceConnect, { websocket: true }, (socket, request) => {
    if (
      request.headers.origin &&
      !/^chrome-extension:\/\/[a-p]{32}$/u.test(request.headers.origin)
    ) {
      socket.close(1008, "Extension origin required");
      return;
    }
    try {
      service.acceptSocket(
        socket,
        browserSourceIngressOrigin(request, canonicalOrigin),
        request.raw.socket.remoteAddress ?? "unknown",
      );
    } catch {
      socket.close(1008, "Invalid source route");
    }
  });
}

function browserSourceIngressOrigin(request: FastifyRequest, canonicalOrigin: string): string {
  // Routers need only preserve Host for the Deployment's canonical authority.
  // Personal remote routes still require the exact external scheme and Host.
  if (request.headers.host === new URL(canonicalOrigin).host) return canonicalOrigin;
  return exchangeRouteOrigin(request);
}

function requireOwner(context: HostApiServerContext) {
  if (!context.session)
    throw new OpensteerError({
      code: "unauthorized",
      message: "Sign in to use Chrome sign-ins",
    });
  return context.session.user.id;
}

/** Chrome grants host access to extension workers; this also covers preflighted installs. */
export function setBrowserSourceExtensionCors(
  reply: FastifyReply,
  origin: string | undefined,
): boolean {
  if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/u.test(origin)) return false;
  void reply.header("access-control-allow-origin", origin);
  void reply.header("vary", "Origin");
  return true;
}
