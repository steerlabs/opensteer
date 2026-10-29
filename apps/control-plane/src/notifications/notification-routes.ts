import {
  ListNotificationDevicesResponseSchema,
  HostNotificationPublicationSchema,
  HostNotificationPublicationResponseSchema,
  NotificationInstallationIdSchema,
  type NotificationDevicePlatform,
  RegisterNotificationDeviceRequestSchema,
  RegisterNotificationDeviceResponseSchema,
  UnregisterNotificationDeviceResponseSchema,
} from "@opensteer/control-plane-protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ControlPlaneAuthenticator } from "../auth/auth.js";
import { ControlPlaneError } from "../server/errors.js";
import type { ControlPlaneStore } from "../database/store.js";
import type { ControlPlaneNotificationStore } from "./notification-store.js";
import { toWebHeaders } from "../portal/routes.js";

const InstallationParamsSchema = z.strictObject({
  installationId: NotificationInstallationIdSchema,
});

export interface NotificationRouteDependencies {
  readonly authenticator: ControlPlaneAuthenticator;
  readonly notifications?: ControlPlaneNotificationStore;
  /** The platforms this control plane holds provider credentials for. */
  readonly notificationPlatforms?: readonly NotificationDevicePlatform[];
  readonly store: ControlPlaneStore;
}

/**
 * Registration is the phone's own surface and the Host publication is the
 * Deployment's; they live together because they are two ends of one path.
 *
 * Registration is refused to every credential but the mobile application's.
 * The desktop and the browser have a screen in front of the person already, and
 * a push registration made from either would be a device nobody can see or
 * revoke from the phone that receives it.
 */
export function registerNotificationRoutes(
  app: FastifyInstance,
  dependencies: NotificationRouteDependencies,
): void {
  app.put("/v1/account/notification-devices/:installationId", async (request, reply) => {
    const notifications = requirePush(dependencies.notifications);
    const { installationId } = InstallationParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    requireMobileApplication(principal.application);
    const body = RegisterNotificationDeviceRequestSchema.parse(request.body);
    if (!dependencies.notificationPlatforms?.includes(body.platform)) throw pushNotConfigured();
    void reply.header("cache-control", "no-store");
    return RegisterNotificationDeviceResponseSchema.parse({
      device: await notifications.registerDevice({
        accountId: principal.accountId,
        ...body,
        installationId,
      }),
    });
  });

  app.delete("/v1/account/notification-devices/:installationId", async (request, reply) => {
    const notifications = requirePush(dependencies.notifications);
    const { installationId } = InstallationParamsSchema.parse(request.params);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      mutation: true,
      scope: "deployments:write",
    });
    requireMobileApplication(principal.application);
    await notifications.unregisterDevice({ accountId: principal.accountId, installationId });
    void reply.header("cache-control", "no-store");
    return UnregisterNotificationDeviceResponseSchema.parse({
      installationId,
      unregistered: true,
    });
  });

  app.get("/v1/account/notification-devices", async (request, reply) => {
    const notifications = requirePush(dependencies.notifications);
    const principal = await dependencies.authenticator.authenticate(toWebHeaders(request.headers), {
      scope: "deployments:read",
    });
    requireMobileApplication(principal.application);
    void reply.header("cache-control", "no-store");
    return ListNotificationDevicesResponseSchema.parse({
      devices: await notifications.listDevices(principal.accountId),
    });
  });

  app.post("/v1/host/notifications", async (request, reply) => {
    const notifications = requirePush(dependencies.notifications);
    if (!dependencies.notificationPlatforms?.length) throw pushNotConfigured();
    const authority = await dependencies.store.authenticateHostCredential(
      firstHeader(request.headers.authorization),
    );
    const publication = HostNotificationPublicationSchema.parse(request.body);
    const accepted = await notifications.ingest(authority, publication);
    void reply.code(202).header("cache-control", "no-store");
    return HostNotificationPublicationResponseSchema.parse({
      accepted: true,
      deliveries: accepted.deliveries,
      notificationId: publication.notificationId,
    });
  });
}

function requirePush(
  notifications: ControlPlaneNotificationStore | undefined,
): ControlPlaneNotificationStore {
  if (!notifications) throw pushNotConfigured();
  return notifications;
}

function pushNotConfigured(): ControlPlaneError {
  return new ControlPlaneError(
    "not_found",
    "Push notifications are not configured on this control plane",
    { reason: "push-not-configured" },
  );
}

function requireMobileApplication(application: string | null): void {
  if (application !== "mobile") {
    throw new ControlPlaneError(
      "forbidden",
      "Push registration belongs to the Opensteer mobile application",
    );
  }
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : value?.[0];
}
