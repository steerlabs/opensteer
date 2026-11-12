import { readFileSync } from "node:fs";
import { request } from "node:https";
import { z } from "zod";
import type { KubernetesApi, ManagedNamespace, ManagedStatefulSet } from "./reconcile.js";
import {
  appliedHashAnnotation,
  managedBy,
  managedByLabel,
  setupGenerationAnnotation,
  teamIdLabel,
  teamObjectName,
  teamSecretName,
  type KubernetesObject,
} from "./template.js";

const serviceAccountDirectory = "/var/run/secrets/kubernetes.io/serviceaccount";
const fieldManager = "opensteer-team-provisioner";
const requestTimeoutMilliseconds = 30_000;
const maximumResponseBytes = 16 * 1024 * 1024;
const managedSelector = `${managedByLabel}=${managedBy}`;

const collectionPaths: Readonly<Record<string, string>> = {
  LimitRange: "/api/v1/namespaces/{namespace}/limitranges",
  NetworkPolicy: "/apis/networking.k8s.io/v1/namespaces/{namespace}/networkpolicies",
  ResourceQuota: "/api/v1/namespaces/{namespace}/resourcequotas",
  Secret: "/api/v1/namespaces/{namespace}/secrets",
  Service: "/api/v1/namespaces/{namespace}/services",
  StatefulSet: "/apis/apps/v1/namespaces/{namespace}/statefulsets",
};

const NamespaceListSchema = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ name: z.string() }),
      status: z.object({ phase: z.string().optional() }).optional(),
    }),
  ),
});

const StatefulSetListSchema = z.object({
  items: z.array(
    z.object({
      metadata: z.object({
        name: z.string(),
        generation: z.number().optional(),
        labels: z.record(z.string(), z.string()).optional(),
        annotations: z.record(z.string(), z.string()).optional(),
      }),
      spec: z.object({
        replicas: z.number().optional(),
        template: z.object({
          metadata: z
            .object({ annotations: z.record(z.string(), z.string()).optional() })
            .optional(),
          spec: z.object({
            containers: z.array(z.object({ name: z.string(), image: z.string() })),
          }),
        }),
      }),
      status: z
        .object({
          observedGeneration: z.number().optional(),
          replicas: z.number().optional(),
          readyReplicas: z.number().optional(),
          updatedReplicas: z.number().optional(),
          currentRevision: z.string().optional(),
          updateRevision: z.string().optional(),
        })
        .optional(),
    }),
  ),
});

const SecretSchema = z.object({ data: z.record(z.string(), z.string()).optional() });

export class KubernetesRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "KubernetesRequestError";
    this.status = status;
  }
}

/**
 * The few Kubernetes REST calls the provisioner makes, as its in-cluster service account. The
 * token is reread on every call because the kubelet rotates it in place.
 */
export class KubernetesClient implements KubernetesApi {
  readonly #server: URL;
  readonly #ca: Buffer;

  constructor(input: { readonly host: string; readonly port: string }) {
    this.#server = new URL(
      `https://${input.host.includes(":") ? `[${input.host}]` : input.host}:${input.port}`,
    );
    this.#ca = readFileSync(`${serviceAccountDirectory}/ca.crt`);
  }

  async listNamespaces(): Promise<readonly ManagedNamespace[]> {
    const list = NamespaceListSchema.parse(
      await this.#call(
        "GET",
        `/api/v1/namespaces?labelSelector=${encodeURIComponent(managedSelector)}`,
      ),
    );
    return list.items.map((item) => ({
      name: item.metadata.name,
      terminating: item.status?.phase === "Terminating",
    }));
  }

  async listStatefulSets(): Promise<readonly ManagedStatefulSet[]> {
    const list = StatefulSetListSchema.parse(
      await this.#call(
        "GET",
        `/apis/apps/v1/statefulsets?labelSelector=${encodeURIComponent(managedSelector)}`,
      ),
    );
    return list.items.flatMap((item) => {
      const teamId = item.metadata.labels?.[teamIdLabel];
      if (!teamId || item.metadata.name !== teamObjectName) return [];
      const image = (name: string) =>
        item.spec.template.spec.containers.find((container) => container.name === name)?.image ??
        null;
      const replicas = item.spec.replicas ?? 1;
      const status = item.status ?? {};
      const observed = (status.observedGeneration ?? 0) >= (item.metadata.generation ?? 0);
      return [
        {
          teamId,
          appliedHash: item.metadata.annotations?.[appliedHashAnnotation] ?? null,
          hostImage: image("host"),
          gatewayImage: image("gateway"),
          replicas,
          setupGeneration: Number(
            item.spec.template.metadata?.annotations?.[setupGenerationAnnotation] ?? 0,
          ),
          settled:
            observed &&
            (status.replicas ?? 0) === replicas &&
            (status.readyReplicas ?? 0) === replicas &&
            (status.updatedReplicas ?? 0) === replicas &&
            status.currentRevision === status.updateRevision,
        },
      ];
    });
  }

  async apply(object: KubernetesObject): Promise<void> {
    const query = `?fieldManager=${fieldManager}&force=true`;
    await this.#call("PATCH", `${objectPath(object)}${query}`, {
      body: object,
      contentType: "application/apply-patch+yaml",
    });
  }

  async readSetupTokenDigest(namespace: string): Promise<string | undefined> {
    try {
      const secret = SecretSchema.parse(
        await this.#call("GET", `/api/v1/namespaces/${namespace}/secrets/${teamSecretName}`),
      );
      const value = secret.data?.["setup-token-digest"];
      return value === undefined ? "" : Buffer.from(value, "base64").toString("utf8");
    } catch (error) {
      if (error instanceof KubernetesRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  async createSecret(secret: KubernetesObject): Promise<void> {
    try {
      await this.#call("POST", collectionPath("Secret", secret.metadata.namespace!), {
        body: secret,
        contentType: "application/json",
      });
    } catch (error) {
      // Another pass created it first; its values stand.
      if (error instanceof KubernetesRequestError && error.status === 409) return;
      throw error;
    }
  }

  async writeSetupTokenDigest(namespace: string, digest: string): Promise<void> {
    await this.#call("PATCH", `/api/v1/namespaces/${namespace}/secrets/${teamSecretName}`, {
      body: { stringData: { "setup-token-digest": digest } },
      contentType: "application/merge-patch+json",
    });
  }

  async deleteNamespace(name: string): Promise<void> {
    try {
      await this.#call("DELETE", `/api/v1/namespaces/${name}`);
    } catch (error) {
      if (error instanceof KubernetesRequestError && error.status === 404) return;
      throw error;
    }
  }

  #call(
    method: string,
    path: string,
    payload?: { readonly body: unknown; readonly contentType: string },
  ): Promise<unknown> {
    const token = readFileSync(`${serviceAccountDirectory}/token`, "utf8").trim();
    const body = payload ? JSON.stringify(payload.body) : undefined;
    return new Promise((resolve, reject) => {
      const outgoing = request(
        new URL(path, this.#server),
        {
          ca: this.#ca,
          method,
          timeout: requestTimeoutMilliseconds,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(payload ? { "content-type": payload.contentType } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximumResponseBytes) response.destroy(new Error("Response is too large"));
            else chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            const status = response.statusCode ?? 0;
            if (status < 200 || status >= 300) {
              // A Kubernetes Status message names the object and the rule, never Secret data.
              const message = z.object({ message: z.string() }).safeParse(safeJson(text))
                .data?.message;
              reject(
                new KubernetesRequestError(
                  status,
                  `${method} ${path.split("?")[0]} failed with ${status}${message ? `: ${message.slice(0, 300)}` : ""}`,
                ),
              );
              return;
            }
            resolve(text ? safeJson(text) : null);
          });
        },
      );
      outgoing.on("timeout", () => outgoing.destroy(new Error(`${method} ${path} timed out`)));
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  }
}

function objectPath(object: KubernetesObject): string {
  if (object.kind === "Namespace") return `/api/v1/namespaces/${object.metadata.name}`;
  return `${collectionPath(object.kind, object.metadata.namespace!)}/${object.metadata.name}`;
}

function collectionPath(kind: string, namespace: string): string {
  const template = collectionPaths[kind];
  if (!template) throw new Error(`The provisioner does not manage ${kind} objects`);
  return template.replace("{namespace}", namespace);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
