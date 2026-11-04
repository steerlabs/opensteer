import type { FastifyInstance } from "fastify";
import { OpensteerError } from "@opensteer/core";
import {
  DesktopUpdateRequestSchema,
  DesktopUpdateStatusQuerySchema,
  desktopUpdateMaximumBytes,
} from "@opensteer/protocol/maintenance";
import type { HostAuthenticator } from "../identity/auth.js";
import type { PersonalDesktopUpdate } from "./personal-desktop-update.js";
import { requirePersonalAdministrator } from "./personal-remote-administration.js";

export function registerDesktopUpdateMaintenance(
  app: FastifyInstance,
  auth: Pick<HostAuthenticator, "authenticateSession">,
  updates: PersonalDesktopUpdate | null,
): void {
  app.get("/maintenance/v1/desktop-update", async (request, reply) => {
    const session = await auth.authenticateSession(request.headers);
    requirePersonalAdministrator(session);
    const { after } = DesktopUpdateStatusQuerySchema.parse(request.query);
    void reply.header("cache-control", "no-store");
    if (!updates)
      return { supported: false, state: null, operation: null, revision: "unsupported" };
    const controller = new AbortController();
    const abandon = () => controller.abort(new Error("Maintenance request abandoned"));
    request.raw.once("aborted", abandon);
    reply.raw.once("close", abandon);
    try {
      await updates.wait(after, controller.signal);
      const current = await auth.authenticateSession(request.headers);
      return await updates.status(current);
    } finally {
      request.raw.removeListener("aborted", abandon);
      reply.raw.removeListener("close", abandon);
    }
  });
  app.post(
    "/maintenance/v1/desktop-update",
    { bodyLimit: desktopUpdateMaximumBytes },
    async (request, reply) => {
      const session = await auth.authenticateSession(request.headers, { mutation: true });
      requirePersonalAdministrator(session);
      if (!updates)
        throw new OpensteerError({
          code: "conflict",
          message:
            "Remote desktop updates are unsupported on server Deployments. Update on that computer.",
        });
      void reply.header("cache-control", "no-store");
      return updates.request(session, DesktopUpdateRequestSchema.parse(request.body));
    },
  );
}
