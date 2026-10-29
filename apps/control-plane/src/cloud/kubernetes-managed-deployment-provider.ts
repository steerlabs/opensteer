import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { readBoundedJson, readBoundedText } from "@opensteer/shared/boundedJson";
import { isRecord } from "@opensteer/shared/isRecord";
import { z } from "zod";
import {
  KubernetesManagedDeploymentTemplateSchema,
  kubernetesManagedDeploymentResources,
  kubernetesManagedTeardownJob,
  managedDeploymentNamespace,
  managedDeploymentOperationTemplate,
  managedDeploymentPlacement,
  managedDeploymentRelease,
  managedWorkloads,
  type KubernetesManagedDeploymentTemplate,
  type KubernetesObject,
  type ManagedWorkload,
} from "./kubernetes-managed-deployment-resources.js";
import type { CloudDeploymentEnsureResult, CloudDeploymentProvider } from "./lifecycle.js";

/**
 * Kubernetes already decides this: `Progressing=False` with `ProgressDeadlineExceeded` is its
 * terminal verdict on a rollout, so a crash-looping workload is named instead of waited out.
 */
export type ManagedWorkloadStatus =
  | { readonly state: "ready" }
  | { readonly state: "progressing" }
  | { readonly state: "failed"; readonly reason: string };

const maximumResponseBytes = 1_048_576;
const metadataTokenMaximumBytes = 16_384;
const metadataTokenUrl =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

export interface EnsureKubernetesManagedDeploymentInput {
  readonly canonicalOrigin: string;
  readonly deploymentId: DeploymentId;
  readonly name: string;
  readonly operationId: string;
  readonly secrets: Readonly<Record<string, string>>;
}

export type DeleteKubernetesManagedDeploymentInput = EnsureKubernetesManagedDeploymentInput;

export interface KubernetesManagedDeploymentClient {
  apply(resource: KubernetesObject): Promise<void>;
  deleteJob(namespace: string, name: string): Promise<void>;
  deleteNamespace(namespace: string): Promise<boolean>;
  deploymentScaledDown(namespace: string, name: string): Promise<boolean>;
  jobStatus(namespace: string, name: string): Promise<"absent" | "complete" | "failed" | "pending">;
  namespaceState(
    namespace: string,
    deploymentId: DeploymentId,
    operationId: string,
  ): Promise<"absent" | "active" | "terminating">;
  resourceExists(resource: KubernetesObject): Promise<boolean>;
  scaleDeployment(namespace: string, name: string, replicas: number): Promise<void>;
  validateConfiguration(template: KubernetesManagedDeploymentTemplate): Promise<void>;
  workloadStatus(namespace: string, name: string): Promise<ManagedWorkloadStatus>;
}

export class KubernetesManagedDeploymentProvider implements CloudDeploymentProvider {
  readonly #clientForTemplate: (
    template: KubernetesManagedDeploymentTemplate,
  ) => KubernetesManagedDeploymentClient;
  readonly #template: KubernetesManagedDeploymentTemplate;

  constructor(input: {
    readonly client?: KubernetesManagedDeploymentClient;
    readonly clientForTemplate?: (
      template: KubernetesManagedDeploymentTemplate,
    ) => KubernetesManagedDeploymentClient;
    readonly template: KubernetesManagedDeploymentTemplate;
  }) {
    if ((input.client === undefined) === (input.clientForTemplate === undefined)) {
      throw new Error("Exactly one Kubernetes managed Deployment client source is required.");
    }
    const directClient = input.client;
    this.#clientForTemplate =
      input.clientForTemplate ??
      (() => {
        if (!directClient) throw new Error("Kubernetes managed Deployment client is missing.");
        return directClient;
      });
    this.#template = KubernetesManagedDeploymentTemplateSchema.parse(input.template);
  }

  /** Only the placement is durable; the release travels with the running Account. */
  captureConfiguration(): string {
    return JSON.stringify(managedDeploymentPlacement(this.#template));
  }

  currentRelease(): string {
    return managedDeploymentRelease(this.#template);
  }

  async validateConfiguration(): Promise<void> {
    await this.#clientForTemplate(this.#template).validateConfiguration(this.#template);
  }

  async ensure(
    input: EnsureKubernetesManagedDeploymentInput,
  ): Promise<CloudDeploymentEnsureResult> {
    const deploymentId = DeploymentIdSchema.parse(input.deploymentId);
    const template = this.#operationTemplate(input.secrets);
    const client = this.#clientForTemplate(template);
    const namespace = managedDeploymentNamespace(template.namespacePrefix, deploymentId);
    const namespaceState = await client.namespaceState(namespace, deploymentId, input.operationId);
    if (namespaceState === "terminating") return { ready: false, waiting: [...managedWorkloads] };
    const resources = kubernetesManagedDeploymentResources({
      ...input,
      deploymentId,
      namespace,
      template,
    });
    for (const resource of resources) await client.apply(resource);
    const statuses = await Promise.all(
      managedWorkloads.map(
        async (name) => [name, await client.workloadStatus(namespace, name)] as const,
      ),
    );
    const failure = statuses.find(
      (entry): entry is readonly [ManagedWorkload, { state: "failed"; reason: string }] =>
        entry[1].state === "failed",
    );
    if (failure)
      return { ready: false, failed: { reason: failure[1].reason, workload: failure[0] } };
    const waiting = statuses.filter(([, status]) => status.state !== "ready").map(([name]) => name);
    return waiting.length === 0 ? { ready: true } : { ready: false, waiting };
  }

  async delete(input: DeleteKubernetesManagedDeploymentInput): Promise<boolean> {
    DeploymentIdSchema.parse(input.deploymentId);
    if (!input.operationId) throw new Error("Managed Deployment operation ID is required.");
    const template = this.#operationTemplate(input.secrets);
    const client = this.#clientForTemplate(template);
    const namespace = managedDeploymentNamespace(template.namespacePrefix, input.deploymentId);
    const namespaceState = await client.namespaceState(
      namespace,
      input.deploymentId,
      input.operationId,
    );
    if (namespaceState === "absent") return true;
    if (namespaceState === "terminating") return false;
    const postgresData = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "postgres-data", namespace },
    };
    if (!(await client.resourceExists(postgresData))) return client.deleteNamespace(namespace);
    const stoppedWorkloads = [
      "runner",
      "channel-runtime",
      "browser-runtime",
      "browser-egress",
      "host",
    ] as const;
    for (const name of stoppedWorkloads) {
      await client.scaleDeployment(namespace, name, 0);
    }
    const stopped = await Promise.all(
      stoppedWorkloads.map((name) => client.deploymentScaledDown(namespace, name)),
    );
    if (!stopped.every(Boolean)) return false;
    const resources = kubernetesManagedDeploymentResources({
      ...input,
      purpose: "teardown",
      deploymentId: input.deploymentId,
      namespace,
      template,
    });
    for (const resource of resources.filter(isTeardownPrerequisite)) {
      await client.apply(resource);
    }
    if ((await client.workloadStatus(namespace, "postgres")).state !== "ready") return false;
    const jobStatus = await client.jobStatus(namespace, "managed-teardown");
    if (jobStatus === "complete") return client.deleteNamespace(namespace);
    if (jobStatus === "failed") {
      await client.deleteJob(namespace, "managed-teardown");
      return false;
    }
    if (jobStatus === "pending") return false;
    await client.apply(
      kubernetesManagedTeardownJob({
        canonicalOrigin: input.canonicalOrigin,
        deploymentId: input.deploymentId,
        name: input.name,
        namespace,
        operationId: input.operationId,
        template,
        // The release is live, so teardown always runs the currently deployed Host image.
        teardownImage: template.hostImage,
      }),
    );
    return false;
  }

  /** Placement from the operation's snapshot, release from the template this Account runs. */
  #operationTemplate(
    secrets: Readonly<Record<string, string>>,
  ): KubernetesManagedDeploymentTemplate {
    const serialized = secrets["hosting-template.json"];
    if (!serialized) throw new Error("Managed Deployment hosting template snapshot is missing.");
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch (error) {
      throw new Error("Managed Deployment hosting template snapshot is invalid.", { cause: error });
    }
    return managedDeploymentOperationTemplate(managedDeploymentPlacement(decoded), this.#template);
  }
}

export async function readKubernetesManagedDeploymentTemplate(
  filePath: string,
): Promise<KubernetesManagedDeploymentTemplate> {
  const decoded: unknown = JSON.parse(await readFile(filePath, "utf8"));
  return KubernetesManagedDeploymentTemplateSchema.parse(decoded);
}

export interface GoogleAccessTokenProvider {
  accessToken(): Promise<string>;
}

const GoogleMetadataTokenSchema = z.strictObject({
  access_token: z
    .string()
    .min(1)
    .max(8_192)
    .regex(/^[A-Za-z0-9._~-]+$/u),
  expires_in: z.number().int().min(60).max(86_400),
  token_type: z.literal("Bearer"),
});

export class GoogleMetadataAccessTokenProvider implements GoogleAccessTokenProvider {
  readonly #fetch: typeof globalThis.fetch;
  #cached?: { readonly expiresAt: number; readonly token: string };

  constructor(fetchImplementation: typeof globalThis.fetch = globalThis.fetch) {
    this.#fetch = fetchImplementation;
  }

  async accessToken(): Promise<string> {
    const now = Date.now();
    if (this.#cached && this.#cached.expiresAt - 60_000 > now) return this.#cached.token;
    const response = await this.#fetch(metadataTokenUrl, {
      headers: { "Metadata-Flavor": "Google" },
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(`Google metadata access token request failed with HTTP ${response.status}.`);
    }
    const decoded = GoogleMetadataTokenSchema.parse(
      await readBoundedJson(response, {
        expectedContentType: "application/json",
        maximumBytes: metadataTokenMaximumBytes,
        sizeError: () => new Error("Google metadata access token response is too large."),
      }),
    );
    this.#cached = { expiresAt: now + decoded.expires_in * 1_000, token: decoded.access_token };
    return decoded.access_token;
  }
}

export class GkeKubernetesManagedDeploymentClient implements KubernetesManagedDeploymentClient {
  readonly #server: URL;
  readonly #ca: string;
  readonly #accessTokenProvider: GoogleAccessTokenProvider;

  constructor(input: {
    readonly accessTokenProvider: GoogleAccessTokenProvider;
    readonly ca: string;
    readonly server: string;
  }) {
    this.#server = new URL(input.server);
    if (this.#server.protocol !== "https:" || this.#server.origin !== input.server) {
      throw new Error("Kubernetes API server must be a bare HTTPS origin.");
    }
    this.#ca = input.ca;
    this.#accessTokenProvider = input.accessTokenProvider;
  }

  async validateConfiguration(template: KubernetesManagedDeploymentTemplate): Promise<void> {
    const storageClass = await this.#request(
      "GET",
      `/apis/storage.k8s.io/v1/storageclasses/${encodeURIComponent(template.storageClassName)}`,
    );
    if (storageClass.status !== 200)
      throw new Error(
        `Kubernetes storage class validation failed with HTTP ${storageClass.status}.`,
      );
    const decodedStorageClass = JSON.parse(storageClass.text) as unknown;
    if (!isRecord(decodedStorageClass) || decodedStorageClass.reclaimPolicy !== "Delete") {
      throw new Error("Managed Deployment storage class must use the Delete reclaim policy.");
    }
    const nodes = await this.#request("GET", "/api/v1/nodes");
    if (nodes.status !== 200)
      throw new Error(`Kubernetes node capacity validation failed with HTTP ${nodes.status}.`);
    const decodedNodes = JSON.parse(nodes.text) as unknown;
    if (!isRecord(decodedNodes) || !Array.isArray(decodedNodes.items)) {
      throw new Error("Kubernetes node capacity response is invalid.");
    }
    const fuseAvailable = decodedNodes.items.some((node) => {
      if (!isRecord(node) || !isRecord(node.status) || !isRecord(node.status.allocatable))
        return false;
      const conditions = node.status.conditions;
      const ready =
        Array.isArray(conditions) &&
        conditions.some(
          (condition) =>
            isRecord(condition) && condition.type === "Ready" && condition.status === "True",
        );
      const capacity = node.status.allocatable[template.fuseResourceName];
      return ready && typeof capacity === "string" && /^[1-9][0-9]*$/u.test(capacity);
    });
    if (!fuseAvailable) {
      throw new Error(
        `No Kubernetes node advertises the configured FUSE resource ${template.fuseResourceName}.`,
      );
    }
  }

  async apply(resource: KubernetesObject): Promise<void> {
    const response = await this.#request(
      "PATCH",
      `${resourcePath(resource)}?fieldManager=opensteer-control-plane&force=true`,
      JSON.stringify(resource),
      "application/apply-patch+yaml",
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Kubernetes apply failed for ${resource.kind}/${resource.metadata.name} with HTTP ${response.status}.`,
      );
    }
  }

  async deleteNamespace(namespace: string): Promise<boolean> {
    const response = await this.#request(
      "DELETE",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}`,
      JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Foreground" }),
      "application/json",
    );
    if (response.status === 404) return true;
    if (response.status === 200 || response.status === 202) return false;
    throw new Error(`Kubernetes Namespace deletion failed with HTTP ${response.status}.`);
  }

  async deleteJob(namespace: string, name: string): Promise<void> {
    const response = await this.#request(
      "DELETE",
      `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs/${encodeURIComponent(name)}`,
      JSON.stringify({ apiVersion: "v1", kind: "DeleteOptions", propagationPolicy: "Background" }),
      "application/json",
    );
    if (response.status !== 200 && response.status !== 202 && response.status !== 404) {
      throw new Error(`Kubernetes Job deletion failed with HTTP ${response.status}.`);
    }
  }

  async namespaceState(
    namespace: string,
    deploymentId: DeploymentId,
    operationId: string,
  ): Promise<"absent" | "active" | "terminating"> {
    const response = await this.#request(
      "GET",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}`,
    );
    if (response.status === 404) return "absent";
    if (response.status !== 200)
      throw new Error(`Kubernetes Namespace read failed with HTTP ${response.status}.`);
    const decoded = JSON.parse(response.text) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.metadata)) {
      throw new Error("Kubernetes Namespace metadata is invalid.");
    }
    const labels = decoded.metadata.labels;
    const annotations = decoded.metadata.annotations;
    if (
      !isRecord(labels) ||
      labels["app.kubernetes.io/managed-by"] !== "opensteer-control-plane" ||
      labels["opensteer.dev/deployment-id"] !== deploymentId ||
      !isRecord(annotations) ||
      annotations["opensteer.dev/operation-id"] !== operationId
    ) {
      throw new Error("Kubernetes Namespace ownership does not match the managed operation.");
    }
    return typeof decoded.metadata.deletionTimestamp === "string" ? "terminating" : "active";
  }

  async scaleDeployment(namespace: string, name: string, replicas: number): Promise<void> {
    const response = await this.#request(
      "PATCH",
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments/${encodeURIComponent(name)}/scale`,
      JSON.stringify({
        apiVersion: "autoscaling/v1",
        kind: "Scale",
        metadata: { name, namespace },
        spec: { replicas },
      }),
      "application/merge-patch+json",
    );
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`Kubernetes Deployment scale failed with HTTP ${response.status}.`);
    }
  }

  async deploymentScaledDown(namespace: string, name: string): Promise<boolean> {
    const resource: KubernetesObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace },
    };
    const response = await this.#request("GET", resourcePath(resource));
    if (response.status !== 200 && response.status !== 404) {
      throw new Error(`Kubernetes Deployment read failed with HTTP ${response.status}.`);
    }
    if (response.status === 200) {
      const decoded = JSON.parse(response.text) as unknown;
      if (!isRecord(decoded) || !isRecord(decoded.spec) || !isRecord(decoded.status)) return false;
      if (
        decoded.spec.replicas !== 0 ||
        (decoded.status.replicas !== undefined && decoded.status.replicas !== 0) ||
        (decoded.status.readyReplicas !== undefined && decoded.status.readyReplicas !== 0)
      )
        return false;
    }
    const pods = await this.#request(
      "GET",
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodeURIComponent(`app.kubernetes.io/name=${name}`)}`,
    );
    if (pods.status !== 200)
      throw new Error(`Kubernetes Pod list failed with HTTP ${pods.status}.`);
    return deploymentPodsAbsent(JSON.parse(pods.text) as unknown);
  }

  async jobStatus(
    namespace: string,
    name: string,
  ): Promise<"absent" | "complete" | "failed" | "pending"> {
    const resource: KubernetesObject = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, namespace },
    };
    const response = await this.#request("GET", resourcePath(resource));
    if (response.status === 404) return "absent";
    if (response.status !== 200)
      throw new Error(`Kubernetes Job read failed with HTTP ${response.status}.`);
    const decoded = JSON.parse(response.text) as unknown;
    if (!isRecord(decoded) || !isRecord(decoded.status)) return "pending";
    const conditions = decoded.status.conditions;
    if (!Array.isArray(conditions)) return "pending";
    if (
      conditions.some(
        (condition) =>
          isRecord(condition) && condition.type === "Complete" && condition.status === "True",
      )
    )
      return "complete";
    return conditions.some(
      (condition) =>
        isRecord(condition) && condition.type === "Failed" && condition.status === "True",
    )
      ? "failed"
      : "pending";
  }

  async resourceExists(resource: KubernetesObject): Promise<boolean> {
    const response = await this.#request("GET", resourcePath(resource));
    if (response.status === 404) return false;
    if (response.status !== 200)
      throw new Error(`Kubernetes resource read failed with HTTP ${response.status}.`);
    return true;
  }

  async workloadStatus(namespace: string, name: string): Promise<ManagedWorkloadStatus> {
    const resource: KubernetesObject = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name, namespace },
    };
    const response = await this.#request("GET", resourcePath(resource));
    if (response.status === 404) return { state: "progressing" };
    if (response.status !== 200)
      throw new Error(`Kubernetes readiness read failed with HTTP ${response.status}.`);
    return managedWorkloadStatus(JSON.parse(response.text) as unknown);
  }

  async #request(
    method: "DELETE" | "GET" | "PATCH",
    requestPath: string,
    body?: string,
    contentType?: string,
  ): Promise<{ readonly status: number; readonly text: string }> {
    const token = await this.#accessTokenProvider.accessToken();
    const url = new URL(requestPath, this.#server);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        url,
        {
          ca: this.#ca,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            ...(body === undefined
              ? {}
              : {
                  "content-length": Buffer.byteLength(body),
                  "content-type": contentType ?? "application/json",
                }),
          },
          method,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const bodyResponse = new Response(Readable.toWeb(response) as ReadableStream);
          void readBoundedText(bodyResponse, {
            fatalUtf8: true,
            maximumBytes: maximumResponseBytes,
            sizeError: () => new Error("Kubernetes API response exceeds its size limit."),
          }).then((text) => resolve({ status, text }), reject);
        },
      );
      request.on("error", reject);
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}

/**
 * Readiness stays exactly what it was — the current generation observed with one updated and
 * available replica — and Kubernetes' own terminal rollout verdict is read alongside it. Until
 * Kubernetes observes the current generation, that verdict still describes the rollout it replaced.
 */
export function managedWorkloadStatus(document: unknown): ManagedWorkloadStatus {
  if (!isRecord(document) || !isRecord(document.metadata) || !isRecord(document.status))
    return { state: "progressing" };
  const status = document.status;
  const observed =
    typeof document.metadata.generation === "number" &&
    status.observedGeneration === document.metadata.generation;
  if (!observed) return { state: "progressing" };
  if (status.availableReplicas === 1 && status.updatedReplicas === 1) return { state: "ready" };
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  const stalled = conditions.find(
    (condition) =>
      isRecord(condition) &&
      condition.type === "Progressing" &&
      condition.status === "False" &&
      typeof condition.reason === "string",
  );
  return isRecord(stalled) && typeof stalled.reason === "string"
    ? { reason: stalled.reason, state: "failed" }
    : { state: "progressing" };
}

export function deploymentPodsAbsent(document: unknown): boolean {
  return isRecord(document) && Array.isArray(document.items) && document.items.length === 0;
}

function isTeardownPrerequisite(resource: KubernetesObject): boolean {
  return (
    (resource.kind === "Secret" &&
      (resource.metadata.name === "runtime" || resource.metadata.name === "postgres-password")) ||
    (resource.kind === "PersistentVolumeClaim" && resource.metadata.name === "postgres-data") ||
    (resource.kind === "Service" && resource.metadata.name === "postgres") ||
    (resource.kind === "Deployment" && resource.metadata.name === "postgres") ||
    resource.kind === "NetworkPolicy"
  );
}

function resourcePath(resource: KubernetesObject): string {
  const namespace = resource.metadata.namespace;
  const name = encodeURIComponent(resource.metadata.name);
  if (resource.kind === "Namespace") return `/api/v1/namespaces/${name}`;
  if (!namespace)
    throw new Error(`${resource.kind}/${resource.metadata.name} is missing its namespace.`);
  const scope = `/namespaces/${encodeURIComponent(namespace)}`;
  const plural = kubernetesPlural(resource.kind);
  return resource.apiVersion === "v1"
    ? `/api/v1${scope}/${plural}/${name}`
    : `/apis/${resource.apiVersion}${scope}/${plural}/${name}`;
}

function kubernetesPlural(kind: string): string {
  switch (kind) {
    case "Deployment":
      return "deployments";
    case "Job":
      return "jobs";
    case "Namespace":
      return "namespaces";
    case "NetworkPolicy":
      return "networkpolicies";
    case "PersistentVolumeClaim":
      return "persistentvolumeclaims";
    case "Secret":
      return "secrets";
    case "Service":
      return "services";
    default:
      throw new Error(`Unsupported Kubernetes resource kind ${kind}.`);
  }
}
