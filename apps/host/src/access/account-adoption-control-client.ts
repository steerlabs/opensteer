import { readBoundedJson } from "@opensteer/shared/boundedJson";
import {
  AcknowledgeHostAccountAdoptionRequestSchema,
  AcknowledgeHostAccountAdoptionResponseSchema,
  HostAccountAdoptionProofIdSchema,
} from "@opensteer/control-plane-protocol";

const maximumResponseBytes = 16 * 1_024;

interface AccountAdoptionControlClientOptions {
  readonly controlApiOrigin: URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly hostCredential: string;
}

/** Uses current Host authority to erase the control plane's adoption retry secret. */
export class AccountAdoptionControlClient {
  readonly #controlApiOrigin: URL;
  readonly #fetch: typeof globalThis.fetch;
  readonly #hostCredential: string;

  constructor(options: AccountAdoptionControlClientOptions) {
    this.#controlApiOrigin = exactOrigin(options.controlApiOrigin);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#hostCredential = hostCredential(options.hostCredential);
  }

  async acknowledge(proofIdInput: string): Promise<void> {
    const proofId = HostAccountAdoptionProofIdSchema.parse(proofIdInput);
    const url = new URL(
      `/v1/host/account-adoptions/${encodeURIComponent(proofId)}/acknowledge`,
      this.#controlApiOrigin,
    );
    let response: Response;
    try {
      response = await this.#fetch(url, {
        body: JSON.stringify(AcknowledgeHostAccountAdoptionRequestSchema.parse({})),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#hostCredential}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error("Account adoption acknowledgement failed");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Account adoption acknowledgement returned HTTP ${response.status}`);
    }
    const acknowledged = AcknowledgeHostAccountAdoptionResponseSchema.parse(
      await readBoundedJson(response, boundedJsonOptions),
    );
    if (!acknowledged.acknowledged || acknowledged.proofId !== proofId) {
      throw new Error("Account adoption API acknowledged a different operation");
    }
  }
}

function exactOrigin(input: URL): URL {
  const url = new URL(input.toString());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("Account control API must be an uncredentialed HTTP(S) origin");
  }
  return url;
}

function hostCredential(value: string): string {
  if (!/^osc_[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new TypeError("Account control API Host credential is invalid");
  }
  return value;
}

const boundedJsonOptions = {
  emptyError: () => new Error("Account adoption API returned an empty response"),
  maximumBytes: maximumResponseBytes,
  sizeError: () => new Error("Account adoption response exceeded its size limit"),
} as const;
