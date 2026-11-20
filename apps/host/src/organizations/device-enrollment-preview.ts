import { OpensteerError } from "@opensteer/core";
import { WorkHomeStore, type DatabaseSchema } from "@opensteer/database";
import {
  DeviceEnrollmentPreviewRequestSchema,
  DeviceEnrollmentPreviewResponseSchema,
  deviceEnrollmentPreviewPath,
} from "@opensteer/protocol";
import { hashRunnerEnrollmentToken } from "@opensteer/runner-auth";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { consumeAnonymousRateLimit } from "../identity/anonymous-rate-limit.js";
import { unversionedRoute } from "../server/unversioned-route.js";

export function registerDeviceEnrollmentPreview(
  app: FastifyInstance,
  database: Kysely<DatabaseSchema>,
) {
  const home = new WorkHomeStore(database);
  app.post(
    deviceEnrollmentPreviewPath,
    { config: unversionedRoute, bodyLimit: 8 * 1024 },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const { enrollmentToken } = DeviceEnrollmentPreviewRequestSchema.parse(request.body);
      if (
        !(await consumeAnonymousRateLimit(
          database,
          `device-enrollment-preview:${request.ip}`,
          30,
          new Date(),
        ))
      )
        throw new OpensteerError({
          code: "resource_exhausted",
          message: "Too many device setup attempts.",
        });
      const result = await home.previewDeviceEnrollment(hashRunnerEnrollmentToken(enrollmentToken));
      return reply.send(DeviceEnrollmentPreviewResponseSchema.parse(result));
    },
  );
}
