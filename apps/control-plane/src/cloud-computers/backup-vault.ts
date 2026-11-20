import type { CloudComputerId } from "@opensteer/control-plane-protocol";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { z } from "zod";

export interface BackupKeyVault {
  issue(id: CloudComputerId, password: string): Promise<number>;
  read(id: CloudComputerId, version: number): Promise<string>;
  destroy(id: CloudComputerId): Promise<void>;
}

export class SecretManagerBackupKeyVault implements BackupKeyVault {
  readonly #secrets: string;

  constructor(project: string) {
    this.#secrets = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}/secrets`;
  }

  async issue(id: CloudComputerId, password: string): Promise<number> {
    const secret = this.#name(id);
    await this.#request(
      "POST",
      `${this.#secrets}?secretId=${secret}`,
      {
        replication: { automatic: {} },
      },
      409,
    );
    const data = await this.#request("POST", `${this.#secrets}/${secret}:addVersion`, {
      payload: { data: Buffer.from(password).toString("base64") },
    });
    const { name } = z.object({ name: z.string() }).parse(data);
    return z.coerce.number().int().positive().parse(name.split("/").at(-1));
  }

  async read(id: CloudComputerId, version: number): Promise<string> {
    const result = await this.#request(
      "GET",
      `${this.#secrets}/${this.#name(id)}/versions/${version}:access`,
    );
    const { payload } = z.object({ payload: z.object({ data: z.base64() }) }).parse(result);
    return Buffer.from(payload.data, "base64").toString("utf8");
  }

  async destroy(id: CloudComputerId): Promise<void> {
    await this.#request("DELETE", `${this.#secrets}/${this.#name(id)}`, undefined, 404);
  }

  #name(id: CloudComputerId): string {
    return `opensteer-backup-${id}`;
  }

  async #request(method: string, url: string, body?: object, accept?: number): Promise<unknown> {
    const signal = AbortSignal.timeout(8_000);
    try {
      const token = await fetch(
        "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
        { headers: { "metadata-flavor": "Google" }, redirect: "error", signal },
      );
      const { access_token } = z
        .object({ access_token: z.string() })
        .parse(await json(token, signal));
      const result = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${access_token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: "error",
        signal,
      });
      if (result.status === accept || (method === "DELETE" && result.ok)) {
        await result.body?.cancel();
        return;
      }
      return await json(result, signal);
    } catch {
      throw new Error("Cloud Computer backup key operation failed");
    }
  }
}

async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Secret Manager request failed");
  }
  return JSON.parse(
    new TextDecoder().decode(
      await readBoundedResponse(response, { maximumBytes: 128 * 1024, signal }),
    ),
  );
}
