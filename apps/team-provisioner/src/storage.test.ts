import type { Storage } from "@google-cloud/storage";
import type { GoogleAuth } from "google-auth-library";
import { expect, it, vi } from "vitest";
import { GcsTeamStorage } from "./storage.js";

it("scopes folder access to the team KSA and verifies cleanup before completing", async () => {
  const request = vi.fn(async (input: { method: string; url: string; body?: string }) => {
    if (input.method === "POST") throw { response: { status: 409 } };
    if (input.method === "GET") throw { response: { status: 404 } };
    return { data: {} };
  });
  const deleteFile = vi.fn(async () => {});
  const getFiles = vi
    .fn()
    .mockResolvedValueOnce([[{ delete: deleteFile }]])
    .mockResolvedValue([[]]);
  const fake = { bucket: () => ({ getFiles }) } as unknown as Storage;
  const auth = { request } as unknown as GoogleAuth;
  const storage = new GcsTeamStorage(fake, auth, "bucket", "project", "123");
  const body = (call: number) => JSON.parse(request.mock.calls[call]?.[0].body ?? "null");
  await storage.ensure("id", "team-acme");
  expect(request.mock.calls[1]?.[0]).toMatchObject({
    method: "PUT",
    url: "https://storage.googleapis.com/storage/v1/b/bucket/managedFolders/teams%2Fid%2F/iam",
  });
  expect(body(1)).toMatchObject({
    bindings: [
      {
        role: "roles/storage.objectUser",
        members: [
          "principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/project.svc.id.goog/subject/ns/team-acme/sa/team",
        ],
      },
    ],
  });
  await storage.delete("id");
  expect(body(2)).toEqual({ version: 3, bindings: [] });
  expect(deleteFile).toHaveBeenCalled();
  getFiles.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{}]]);
  await expect(storage.delete("id")).rejects.toThrow();
});
