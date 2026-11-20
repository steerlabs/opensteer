import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { SecretManagerBackupKeyVault } from "./backup-vault.js";

const id = CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001");
const secret = `projects/key-project/secrets/opensteer-backup-${id}`;
const password = "test-only-repository-password";

afterEach(() => vi.restoreAllMocks());

it("issues numbered versions and deletes the entire per-Home secret on erasure", async () => {
  const requests: { method: string; path: string; body?: string }[] = [];
  let deleted = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal")
      return Response.json({ access_token: "fake-workload-identity" });
    expect(init?.headers).toMatchObject({ authorization: "Bearer fake-workload-identity" });
    requests.push({
      method: init?.method ?? "",
      path: url.pathname + url.search,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (init?.method === "DELETE") {
      if (deleted) return new Response(null, { status: 404 });
      deleted = true;
      return Response.json({});
    }
    if (url.pathname.endsWith(":addVersion"))
      return Response.json({ name: `${secret}/versions/7` });
    if (url.pathname.endsWith(":access"))
      return Response.json({ payload: { data: Buffer.from(password).toString("base64") } });
    return new Response(null, { status: 409 });
  });
  const vault = new SecretManagerBackupKeyVault("key-project");
  expect(await vault.issue(id, password)).toBe(7);
  expect(await vault.read(id, 7)).toBe(password);
  await vault.destroy(id);
  await vault.destroy(id);
  expect(requests).toMatchObject([
    { method: "POST", path: `/v1/projects/key-project/secrets?secretId=opensteer-backup-${id}` },
    {
      method: "POST",
      path: `/v1/${secret}:addVersion`,
      body: JSON.stringify({ payload: { data: Buffer.from(password).toString("base64") } }),
    },
    { method: "GET", path: `/v1/${secret}/versions/7:access` },
    { method: "DELETE", path: `/v1/${secret}` },
    { method: "DELETE", path: `/v1/${secret}` },
  ]);
});
