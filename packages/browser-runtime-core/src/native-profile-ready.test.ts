import { afterEach, expect, it, vi } from "vitest";
import { LocalProfileBindingSchema } from "@opensteer/protocol";
import { nativeProfileReadyClient } from "./native-profile-ready.js";
const binding = LocalProfileBindingSchema.parse({
  version: 1,
  deploymentId: "dep_00000000-0000-4000-8000-000000000001",
  profileId: "bpr_00000000-0000-4000-8000-000000000001",
  runnerId: "rnr_00000000-0000-4000-8000-000000000001",
  bindingId: "00000000-0000-4000-8000-000000000001",
  storageInstanceId: "00000000-0000-4000-8000-000000000002",
  engine: "chromium",
});
afterEach(() => vi.unstubAllGlobals());
it("sends only signed authority over trusted HTTP or HTTPS and forwards cancellation", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  const signal = new AbortController().signal;
  await nativeProfileReadyClient()(
    { kind: "profile-local", binding, initialized: false, readyUrl: "http://127.0.0.1:4000/ready" },
    "signed-ticket",
    signal,
  );
  expect(fetch).toHaveBeenCalledWith(new URL("http://127.0.0.1:4000/ready"), {
    method: "POST",
    headers: { authorization: "Bearer signed-ticket" },
    redirect: "error",
    signal,
  });
  for (const readyUrl of [
    "http://untrusted.test/ready",
    "https://user:password@host.test/ready",
    "https://host.test/ready#token",
    "file:///tmp/profile",
  ]) {
    await expect(
      nativeProfileReadyClient()(
        { kind: "profile-local", binding, initialized: false, readyUrl },
        "secret",
        signal,
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  fetch.mockResolvedValue(new Response(null, { status: 409 }));
  await expect(
    nativeProfileReadyClient()(
      { kind: "profile-local", binding, initialized: true, readyUrl: "https://host.test/ready" },
      "ticket",
      signal,
    ),
  ).rejects.toThrow("did not acknowledge");
});
