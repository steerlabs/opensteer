import { createPublicHttpsFetch } from "@opensteer/access/host";
import {
  CompleteTeamSetupAdoptionResponseSchema,
  HostedTeamOwnerCheckResponseSchema,
  IssueHostAccountAdoptionProofResponseSchema,
  teamSetupPaths,
  type CompleteTeamSetupAdoptionRequest,
  type CompleteTeamSetupAdoptionResponse,
  type HostAccountAdoptionAuthority,
  type HostAccountIdentity,
} from "@opensteer/control-plane-protocol";
import {
  HostDescriptorSchema,
  hostKeyFingerprint,
  teamApiCompatibility,
  teamApiVersion,
  teamApiVersionHeader,
  verifyHostDiscoveryEnvelope,
} from "@opensteer/deployment-authority";
import { z } from "zod";

/** Why a call to a team Host failed; `permanent` when trying again with the same input can't help. */
export class HostedTeamHostError extends Error {
  readonly permanent: boolean;

  constructor(message: string, options: { readonly permanent: boolean; readonly cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HostedTeamHostError";
    this.permanent = options.permanent;
  }
}

export interface HostedTeamDiscovery {
  readonly authority: HostAccountAdoptionAuthority;
  readonly hostedBootstrap: boolean;
}

/** The team Host routes Account calls server-side to set up and delete a hosted team. */
export interface HostedTeamHost {
  discover(origin: string): Promise<HostedTeamDiscovery>;
  setupComplete(origin: string): Promise<boolean>;
  /** Exchanges the setup token for the Host's setup admission cookie. */
  exchange(origin: string, token: string): Promise<string>;
  proof(
    origin: string,
    admissionCookie: string,
    account: HostAccountIdentity,
  ): Promise<z.infer<typeof IssueHostAccountAdoptionProofResponseSchema>>;
  complete(
    origin: string,
    request: CompleteTeamSetupAdoptionRequest,
  ): Promise<CompleteTeamSetupAdoptionResponse>;
  isOwner(origin: string, assertion: string): Promise<boolean>;
}

export class HttpHostedTeamHost implements HostedTeamHost {
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: { readonly fetch?: typeof globalThis.fetch } = {}) {
    this.#fetch =
      options.fetch ?? createPublicHttpsFetch({ maxResponseBytes: 64 * 1_024, timeoutMs: 15_000 });
  }

  async discover(origin: string): Promise<HostedTeamDiscovery> {
    const response = await this.#request(origin, "/.well-known/opensteer", { method: "GET" });
    const descriptor = HostDescriptorSchema.safeParse(await readJson(response));
    if (!descriptor.success || descriptor.data.kind !== "team") {
      throw new HostedTeamHostError("The team server answered with something else", {
        permanent: false,
      });
    }
    if (
      teamApiCompatibility(descriptor.data.apiVersion, descriptor.data.minimumApiVersion) !==
      "compatible"
    ) {
      throw new HostedTeamHostError("This team server runs a different Opensteer version", {
        permanent: true,
      });
    }
    let document;
    try {
      document = verifyHostDiscoveryEnvelope(descriptor.data.authority);
    } catch (error) {
      throw new HostedTeamHostError("The team server's identity didn't verify", {
        permanent: true,
        cause: error,
      });
    }
    if (document.canonicalOrigin !== origin || document.deploymentShape.kind !== "team") {
      throw new HostedTeamHostError("The team server claims a different address", {
        permanent: true,
      });
    }
    return {
      authority: {
        canonicalOrigin: document.canonicalOrigin,
        deploymentId: document.deploymentId,
        hostInstanceId: document.hostInstanceId,
        hostKeyFingerprint: hostKeyFingerprint(descriptor.data.authority.publicKey.spki),
      },
      hostedBootstrap: descriptor.data.capabilities.includes("team-hosted-bootstrap-v1"),
    };
  }

  async setupComplete(origin: string): Promise<boolean> {
    const response = await this.#request(origin, teamSetupPaths.state, { method: "GET" });
    return z.object({ complete: z.boolean() }).parse(await readJson(response)).complete;
  }

  async exchange(origin: string, token: string): Promise<string> {
    const response = await this.#post(origin, teamSetupPaths.exchange, { token });
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0]!.trim())
      .filter((value) => value.length > 0)
      .join("; ");
    if (!cookie) {
      throw new HostedTeamHostError("The team server gave no setup admission", {
        permanent: false,
      });
    }
    return cookie;
  }

  async proof(origin: string, admissionCookie: string, account: HostAccountIdentity) {
    const response = await this.#post(origin, teamSetupPaths.adoptionProof, account, {
      cookie: admissionCookie,
    });
    return IssueHostAccountAdoptionProofResponseSchema.parse(await readJson(response));
  }

  async complete(
    origin: string,
    request: CompleteTeamSetupAdoptionRequest,
  ): Promise<CompleteTeamSetupAdoptionResponse> {
    const response = await this.#post(origin, teamSetupPaths.adoptionComplete, request);
    return CompleteTeamSetupAdoptionResponseSchema.parse(await readJson(response));
  }

  async isOwner(origin: string, assertion: string): Promise<boolean> {
    const response = await this.#post(origin, teamSetupPaths.ownerCheck, { assertion });
    return HostedTeamOwnerCheckResponseSchema.parse(await readJson(response)).owner;
  }

  #post(origin: string, path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.#request(origin, path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  async #request(
    origin: string,
    path: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.#fetch(new URL(path, origin), {
        ...init,
        headers: {
          accept: "application/json",
          [teamApiVersionHeader]: String(teamApiVersion),
          ...init.headers,
        },
        cache: "no-store",
        credentials: "omit",
        redirect: "manual",
        referrerPolicy: "no-referrer",
      });
    } catch (error) {
      throw new HostedTeamHostError("The team server isn't reachable yet", {
        permanent: false,
        cause: error,
      });
    }
    if (response.ok) return response;
    await response.body?.cancel().catch(() => undefined);
    // A Host that is up and refuses answers 4xx; the edge answers 5xx while it is still starting.
    const permanent =
      response.status >= 400 && response.status < 500 && ![404, 408, 429].includes(response.status);
    throw new HostedTeamHostError(`The team server refused setup (HTTP ${response.status})`, {
      permanent,
    });
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    throw new HostedTeamHostError("The team server answered with something else", {
      permanent: false,
      cause: error,
    });
  }
}
