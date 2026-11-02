import { OpensteerError } from "@opensteer/core";
import type { FastifyRequest } from "fastify";

/** Node may discard duplicate Authorization fields before exposing request.headers. */
export async function rejectDuplicateCredentialHeaders(request: FastifyRequest): Promise<void> {
  const counts = new Map<string, number>();
  for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
    const name = request.raw.rawHeaders[index]?.toLowerCase();
    if (name !== "authorization" && name !== "origin") continue;
    const count = (counts.get(name) ?? 0) + 1;
    counts.set(name, count);
    if (count > 1) {
      throw new OpensteerError({
        code: name === "authorization" ? "unauthorized" : "forbidden",
        message: `Repeated ${name} header is not allowed`,
      });
    }
  }
}
