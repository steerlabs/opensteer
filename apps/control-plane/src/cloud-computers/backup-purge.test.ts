import { afterEach, expect, it, vi } from "vitest";
import { purgeBackupObjects } from "./backup-purge.js";

const storage = {
  endpoint: "https://s3.example.test",
  bucket: "backups",
  prefix: "home-a",
  region: "us-east-1",
  accessKeyId: "scoped-access-key",
  secretAccessKey: "scoped-secret-key",
};

function listing(contents: string, truncated = false): Response {
  return new Response(`<?xml version="1.0"?>
<ListVersionsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Prefix>home-a%2F</Prefix><EncodingType>url</EncodingType><IsTruncated>${truncated}</IsTruncated>${contents}
</ListVersionsResult>`);
}

afterEach(() => vi.restoreAllMocks());

it("uses the actual provider versions, then verifies a fresh empty listing", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      listing(`
      <Version><Key>home-a%2Fdata%2Fa%20b</Key><VersionId>version-1</VersionId></Version>
      <DeleteMarker><Key>home-a%2Fdata%2Fa%20b</Key><VersionId>marker-1</VersionId></DeleteMarker>
    `),
    )
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(listing(""));
  await expect(purgeBackupObjects(storage)).resolves.toBe(false);
  await expect(purgeBackupObjects(storage)).resolves.toBe(true);
  const [objectUrl, init] = fetch.mock.calls[1]!;
  expect(String(objectUrl)).toBe(
    "https://s3.example.test/backups/home-a/data/a%20b?versionId=version-1",
  );
  expect(String(fetch.mock.calls[2]![0])).toContain("versionId=marker-1");
  expect(String(fetch.mock.calls[0]![0])).toContain("prefix=home-a%2F");
  expect(init).toMatchObject({ method: "DELETE", redirect: "error" });
  expect(new Headers(init?.headers).get("authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=scoped-access-key\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/u,
  );
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(storage.secretAccessKey);
});

it("leaves cleanup pending when a version is outside the Home prefix or a listing is incomplete", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(
      listing("<Version><Key>home-b%2Fdata</Key><VersionId>version-1</VersionId></Version>"),
    )
    .mockResolvedValueOnce(listing("", true));
  await expect(purgeBackupObjects(storage)).rejects.toThrow(
    "Invalid backup storage object identity",
  );
  await expect(purgeBackupObjects(storage)).rejects.toThrow("Invalid backup storage listing");
  expect(fetch).toHaveBeenCalledTimes(2);
});
