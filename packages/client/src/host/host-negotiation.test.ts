import { hostApiVersion } from "@opensteer/deployment-authority";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { createId } from "@opensteer/core";
import { describe, expect, it, vi } from "vitest";
import { classifyClientFailure } from "../connections/operation-error.js";
import { HostClientRequestError } from "./client.js";
import { createHttpHostApiClient } from "./host-api-client.js";
import { unwrapRpcResult } from "./host-session-client.js";

describe("rpc version negotiation", () => {
  const previousHostApiVersion = hostApiVersion - 1;

  it("states this app's protocol epoch on every request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ data: { ok: true }, ok: true }),
    );
    const client = createHttpHostApiClient({
      baseUrl: new URL("https://opensteer.example"),
      fetch,
      onAuthenticationRequired: () => undefined,
    });

    await client["workspace.prefetch"]({ workspaceId: createId("workspace") });

    expect(fetch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ [hostApiVersionHeader]: String(hostApiVersion) }),
      }),
    );
  });

  it("classifies an epoch refusal by its reason, so an attachment says which side is behind", () => {
    // The re-check a running app gets for free: a Host upgraded underneath it
    // refuses `bootstrap.get`, and the attachment that was live learns why.
    const refused = new HostClientRequestError({
      code: "bad_request",
      message: `This deployment speaks Opensteer protocol ${hostApiVersion}; the caller stated ${previousHostApiVersion}.`,
      reason: "unsupported-version",
      status: 400,
    });

    expect(classifyClientFailure(refused)).toEqual({
      classification: "blocked",
      reason: "unsupported-version",
    });
  });

  it("carries the Host's reason onto the error a surface branches on", () => {
    const thrown = (): never =>
      unwrapRpcResult({
        error: {
          code: "bad_request",
          message: `This deployment speaks Opensteer protocol ${previousHostApiVersion}; the caller stated ${hostApiVersion}.`,
          reason: "unsupported-version",
          retryable: false,
        },
        ok: false,
      });

    expect(thrown).toThrow(HostClientRequestError);
    try {
      thrown();
    } catch (error) {
      expect(error).toMatchObject({ code: "bad_request", reason: "unsupported-version" });
    }
  });
});
