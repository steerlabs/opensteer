import type { Storage } from "@google-cloud/storage";
import { expect, it, vi } from "vitest";
import { GcsTeamStorage } from "./storage.js";

it("scopes folder access to the team KSA and verifies cleanup before completing", async () => {
  const request = vi.fn(async (input: { method: string; url: string; data?: unknown }) => {
    if (input.method === "POST") throw { response: { status: 409 } };
    if (input.method === "GET") throw { response: { status: 404 } };
    return { data: {} };
  });
  const deleteFile = vi.fn(async () => {});
  const getFiles = vi
    .fn()
    .mockResolvedValueOnce([[{ delete: deleteFile }]])
    .mockResolvedValue([[]]);
  const fake = { authClient: { request }, bucket: () => ({ getFiles }) } as unknown as Storage;
  const storage = new GcsTeamStorage(fake, "bucket", "project", "123");
  await storage.ensure("id", "team-acme");
  expect(request.mock.calls[1]?.[0]).toMatchObject({
    method: "PUT",
    url: "https://storage.googleapis.com/storage/v1/b/bucket/managedFolders/teams%2Fid%2F/iam",
    data: {
      bindings: [
        {
          role: "roles/storage.objectUser",
          members: [
            "principal://iam.googleapis.com/projects/123/locations/global/workloadIdentityPools/project.svc.id.goog/subject/ns/team-acme/sa/team",
          ],
        },
      ],
    },
  });
  await storage.delete("id");
  expect(request.mock.calls[2]?.[0].data).toEqual({ version: 3, bindings: [] });
  expect(deleteFile).toHaveBeenCalled();
  getFiles.mockResolvedValueOnce([[]]).mockResolvedValueOnce([[{}]]);
  await expect(storage.delete("id")).rejects.toThrow();
});
