import { describe, expect, it } from "vitest";
import { networkLeaveDelivery } from "./phone-leave.js";

const leave = {
  deploymentId: "dep_0192f4a1-0000-4000-8000-000000000001",
  hostUrl: "https://home.example",
  issuedAt: "2026-11-12T18:30:00.000Z",
  runnerId: "rnr_0192f4a1-1111-4111-8111-111111111111",
  signature: "S".repeat(86),
};

function answering(status: number, body: unknown = { outcome: "removed" }) {
  const sent: { url: string; body: unknown; redirect: string }[] = [];
  const deliver = networkLeaveDelivery(async (url, init) => {
    sent.push({ body: JSON.parse(init.body), redirect: init.redirect, url });
    return { json: async () => body, ok: status >= 200 && status < 300, status };
  });
  return { deliver, sent };
}

describe("self-leave delivery", () => {
  it("posts only the signed proof to the pinned route and reads the Host's answer", async () => {
    const { deliver, sent } = answering(200);
    await expect(deliver(leave)).resolves.toBe("removed");
    expect(sent).toEqual([
      {
        body: {
          deploymentId: leave.deploymentId,
          issuedAt: leave.issuedAt,
          runnerId: leave.runnerId,
          signature: leave.signature,
        },
        redirect: "error",
        url: "https://home.example/v1/runner/leave",
      },
    ]);
  });

  it("keeps the obligation while the Host can't answer, and ends it on a final answer", async () => {
    await expect(answering(503).deliver(leave)).resolves.toBe("unreachable");
    await expect(answering(429).deliver(leave)).resolves.toBe("unreachable");
    await expect(answering(200, { outcome: "kept" }).deliver(leave)).resolves.toBe("unreachable");
    await expect(answering(404).deliver(leave)).resolves.toBe("missing");
    await expect(answering(401).deliver(leave)).resolves.toBe("refused");
    const offline = networkLeaveDelivery(async () => {
      throw new TypeError("Network request failed");
    });
    await expect(offline(leave)).resolves.toBe("unreachable");
    await expect(
      answering(200).deliver({ ...leave, hostUrl: "http://home.example" }),
    ).resolves.toBe("refused");
  });
});
