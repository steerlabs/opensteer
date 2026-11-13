import { createId } from "@opensteer/core";
import { hostApiVersionHeader } from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { createDesktopHostApi, DesktopHostApiError, hostApiData } from "./desktop-host-api.js";

const origin = "https://home.opensteer.test";

function recordingHost(answer: (request: Request) => Response) {
  const requests: Request[] = [];
  const api = createDesktopHostApi({
    origin: `${origin}/some/page`,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return answer(request.clone());
    },
  });
  return { api, requests };
}

describe("desktop Host API", () => {
  it("reads sessions the way the Host serves them, and tolerates fields a newer Host adds", async () => {
    const id = createId("authSession");
    const { api, requests } = recordingHost(() =>
      Response.json({
        ok: true,
        data: {
          sessions: [
            {
              id,
              current: true,
              createdAt: "2026-01-01T00:00:00.000Z",
              lastSeenAt: "2026-01-01T00:00:00.000Z",
              expiresAt: "2099-01-01T00:00:00.000Z",
              absoluteExpiresAt: "2099-01-01T00:00:00.000Z",
              deviceLabel: "Opensteer on Mac",
              deviceId: null,
              addedByANewerHost: true,
            },
          ],
        },
      }),
    );
    const { sessions } = hostApiData(await api["sessions.list"]({}));
    expect(sessions.map((session) => session.id)).toEqual([id]);
    const [request] = requests;
    expect(request!.method).toBe("GET");
    expect(request!.url).toBe(`${origin}/v1/rpc/sessions.list?input=%7B%7D`);
    expect(request!.headers.get("origin")).toBe(origin);
    expect(request!.headers.get(hostApiVersionHeader)).not.toBeNull();
  });

  it("posts commands as JSON from this Host's origin and keeps a refusal's code and reason", async () => {
    const { api, requests } = recordingHost(() =>
      Response.json(
        {
          ok: false,
          error: {
            code: "forbidden",
            message: "Device session binding refused",
            reason: "device-mismatch",
            retryable: false,
          },
        },
        { status: 403 },
      ),
    );
    await expect(
      api["commands.dispatch"]({
        type: "machine.revoke",
        machineId: createId("runner"),
        idempotencyKey: "desktop-leave:test",
      }).then(hostApiData),
    ).rejects.toMatchObject({
      name: DesktopHostApiError.name,
      code: "forbidden",
      reason: "device-mismatch",
      retryable: false,
    });
    const [request] = requests;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe(`${origin}/v1/rpc/commands.dispatch`);
    expect(request!.headers.get("origin")).toBe(origin);
    expect(request!.headers.get("content-type")).toBe("application/json");
    await expect(request!.json()).resolves.toMatchObject({ type: "machine.revoke" });
  });
});
