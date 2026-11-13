import { describe, expect, it } from "vitest";
import type { HostClient } from "@opensteer/client/host";
import { phoneEnrollmentHost, registerPhoneEnrollmentHost } from "./phone-enrollment-host.js";

describe("native phone enrollment's Host authority", () => {
  it("releases a refreshed credential only for the exact attached client and Deployment", async () => {
    const client = {} as unknown as HostClient;
    let credential: string | null = "Bearer disposable-session";
    registerPhoneEnrollmentHost(client, {
      deploymentId: "deployment",
      origin: "https://host.example.test",
      hostInstanceId: "hst_pinned",
      authorization: { current: async () => credential, cached: () => null },
    });
    await expect(phoneEnrollmentHost(client, "other")).rejects.toThrow();
    await expect(phoneEnrollmentHost({} as unknown as HostClient, "deployment")).rejects.toThrow();
    await expect(phoneEnrollmentHost(client, "deployment")).resolves.toEqual({
      origin: "https://host.example.test",
      hostInstanceId: "hst_pinned",
      authorization: credential,
    });
    credential = null;
    await expect(phoneEnrollmentHost(client, "deployment")).rejects.toThrow("Sign in");
  });
});
