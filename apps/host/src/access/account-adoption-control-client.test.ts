import { HostAccountAdoptionProofIdSchema } from "@opensteer/control-plane-protocol";
import { describe, expect, it, vi } from "vitest";
import { AccountAdoptionControlClient } from "./account-adoption-control-client.js";

describe("AccountAdoptionControlClient", () => {
  it("acknowledges the exact operation with the Host credential", async () => {
    const proofId = HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`);
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        `https://accounts.example/v1/host/account-adoptions/${proofId}/acknowledge`,
      );
      expect(init).toMatchObject({ method: "POST", redirect: "manual" });
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer osc_${"A".repeat(43)}`);
      expect(JSON.parse(String(init?.body))).toEqual({});
      return Response.json({ acknowledged: true, proofId });
    });
    const client = new AccountAdoptionControlClient({
      controlApiOrigin: new URL("https://accounts.example"),
      fetch,
      hostCredential: `osc_${"A".repeat(43)}`,
    });

    await expect(client.acknowledge(proofId)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched acknowledgement", async () => {
    const proofId = HostAccountAdoptionProofIdSchema.parse(`hap_${crypto.randomUUID()}`);
    const client = new AccountAdoptionControlClient({
      controlApiOrigin: new URL("https://accounts.example"),
      fetch: async () =>
        Response.json({
          acknowledged: true,
          proofId: `hap_${crypto.randomUUID()}`,
        }),
      hostCredential: `osc_${"A".repeat(43)}`,
    });

    await expect(client.acknowledge(proofId)).rejects.toThrow("different operation");
  });
});
