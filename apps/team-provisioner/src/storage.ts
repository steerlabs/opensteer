import type { Storage } from "@google-cloud/storage";
import type { GoogleAuth } from "google-auth-library";
import { z } from "zod";

export interface TeamStorage {
  ensure(id: string, namespace: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export class GcsTeamStorage implements TeamStorage {
  private readonly storage: Storage;
  private readonly auth: GoogleAuth;
  private readonly bucket: string;
  private readonly project: string;
  private readonly projectNumber: string;
  constructor(
    storage: Storage,
    auth: GoogleAuth,
    bucket: string,
    project: string,
    projectNumber: string,
  ) {
    this.storage = storage;
    this.auth = auth;
    this.bucket = bucket;
    this.project = project;
    this.projectNumber = projectNumber;
  }

  async #request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    data?: unknown,
    allowed: readonly number[] = [],
  ) {
    try {
      return await this.auth.request({
        method,
        url: `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/managedFolders${path}`,
        ...(data === undefined
          ? {}
          : { body: JSON.stringify(data), headers: { "content-type": "application/json" } }),
      });
    } catch (error) {
      const code = z.object({ response: z.object({ status: z.number() }) }).safeParse(error).data
        ?.response.status;
      if (code && allowed.includes(code)) return undefined;
      throw new Error(`Storage managed folder operation failed (${code ?? "transport"})`);
    }
  }

  async ensure(id: string, namespace: string): Promise<void> {
    const name = `teams/${id}/`;
    await this.#request("POST", "", { name }, [409]);
    await this.#request("PUT", `/${encodeURIComponent(name)}/iam`, {
      version: 3,
      bindings: [
        {
          role: "roles/storage.objectUser",
          members: [
            `principal://iam.googleapis.com/projects/${this.projectNumber}/locations/global/workloadIdentityPools/${this.project}.svc.id.goog/subject/ns/${namespace}/sa/team`,
          ],
        },
      ],
    });
  }

  async delete(id: string): Promise<void> {
    const prefix = `teams/${id}/`;
    // Revoke writers before listing, so cleanup cannot race a live upload.
    await this.#request(
      "PUT",
      `/${encodeURIComponent(prefix)}/iam`,
      { version: 3, bindings: [] },
      [404],
    );
    const bucket = this.storage.bucket(this.bucket);
    const [files] = await bucket.getFiles({ prefix });
    for (const file of files) await file.delete({ ignoreNotFound: true });
    await this.#request("DELETE", `/${encodeURIComponent(prefix)}`, undefined, [404]);
    const [remaining] = await bucket.getFiles({ prefix, maxResults: 1 });
    if (
      remaining.length ||
      (await this.#request("GET", `/${encodeURIComponent(prefix)}`, undefined, [404]))
    )
      throw new Error("Team storage deletion is incomplete");
  }
}
