import { hostEnvironmentKeys } from "@opensteer/config";
import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import { createHash } from "node:crypto";
import { z } from "zod";

export interface KubernetesObject {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly annotations?: Readonly<Record<string, string>>;
    readonly labels?: Readonly<Record<string, string>>;
    readonly name: string;
    readonly namespace?: string;
  };
  readonly data?: Readonly<Record<string, string>>;
  readonly stringData?: Readonly<Record<string, string>>;
  readonly spec?: unknown;
}

export interface KubernetesContainerEnvironmentVariable {
  readonly name: string;
  readonly value?: string;
  readonly valueFrom?: {
    readonly secretKeyRef: { readonly key: string; readonly name: string };
  };
}

export function managedBrowserRuntimeEnvironment(
  canonicalOrigin: string,
): readonly KubernetesContainerEnvironmentVariable[] {
  return [
    {
      name: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
      valueFrom: {
        secretKeyRef: {
          key: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
          name: "browser-enrollment",
        },
      },
    },
    {
      name: "OPENSTEER_BROWSER_BRIDGE_TOKEN",
      valueFrom: {
        secretKeyRef: { key: "OPENSTEER_BROWSER_BRIDGE_TOKEN", name: "browser-enrollment" },
      },
    },
    { name: "OPENSTEER_BROWSER_HEADLESS", value: "true" },
    { name: "OPENSTEER_BROWSER_HOST", value: "127.0.0.1" },
    { name: "OPENSTEER_BROWSER_PORT", value: "4312" },
    { name: "OPENSTEER_BROWSER_PROFILE_ROOT", value: "/var/lib/opensteer/profiles" },
    { name: "OPENSTEER_BROWSER_PROFILE_STATE_INTERNAL_URL", value: "http://host:4310" },
    { name: "OPENSTEER_BROWSER_PROXY_URL", value: "http://browser-egress:4313" },
    { name: "OPENSTEER_BROWSER_RELAY_HOST_URL", value: canonicalOrigin },
    { name: "OPENSTEER_BROWSER_RUNTIME_DATA_DIR", value: "/var/lib/opensteer/runner" },
    { name: "OPENSTEER_BROWSER_RUNTIME_ID", value: "browser-main" },
    { name: "OPENSTEER_BROWSER_RUNTIME_NAME", value: "Hosted browser" },
    { name: "OPENSTEER_CHROMIUM_SANDBOX", value: "true" },
    { name: "OPENSTEER_MODE", value: "production" },
  ];
}

export function managedRunnerEnvironment(
  canonicalOrigin: string,
  portableFsMountSha256: string,
): readonly KubernetesContainerEnvironmentVariable[] {
  return [
    {
      name: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
      valueFrom: {
        secretKeyRef: {
          key: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
          name: "runner-enrollment",
        },
      },
    },
    { name: "OPENSTEER_HOST_URL", value: canonicalOrigin },
    { name: "OPENSTEER_DEPLOYMENT_KIND", value: "server" },
    { name: "OPENSTEER_MODE", value: "production" },
    { name: "OPENSTEER_PORTABLEFS_MOUNT_BINARY", value: "/opt/portablefs/portablefs" },
    {
      name: "OPENSTEER_PORTABLEFS_MOUNT_SHA256",
      value: portableFsMountSha256.slice("sha256:".length),
    },
    { name: "OPENSTEER_RUNNER_KIND", value: "main" },
    { name: "OPENSTEER_RUNNER_DATA_DIR", value: "/var/lib/opensteer" },
    { name: "OPENSTEER_RUNNER_READINESS_PATH", value: "/var/lib/opensteer/ready.json" },
    { name: "OPENSTEER_RUNNER_WORKSPACE_BACKINGS", value: "portablefs" },
    { name: "OPENSTEER_RUNNER_WORKSPACE_ROOT", value: "/workspaces" },
    { name: hostEnvironmentKeys.defaultWorkspaceBacking, value: "portablefs" },
  ];
}

const PinnedImageSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_048)
  .regex(/@sha256:[a-f0-9]{64}$/u, "Image must be pinned by a SHA-256 digest");

const ManagedRuntimeSecretsSchema = z
  .object({
    "account-bundle.json": z.string().min(1).max(131_072),
    "credential.key": z.string().min(32).max(4_096),
    "host-private.pem": z.string().min(1).max(65_536),
    "host-public.pem": z.string().min(1).max(65_536),
    OPENSTEER_AUTH_SECRET: z.string().min(32).max(8_192),
    OPENSTEER_BROWSER_BRIDGE_TOKEN: z.string().min(32).max(4_096),
    OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN: z.string().min(32).max(4_096),
    OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN: z.string().min(32).max(4_096),
    OPENSTEER_RUNNER_ENROLLMENT_TOKEN: z.string().min(32).max(4_096),
    POSTGRES_PASSWORD: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u),
  })
  .passthrough();

// Deleting an older deployment must not require credentials for newer computers.
const ManagedTeardownSecretsSchema = ManagedRuntimeSecretsSchema.omit({
  OPENSTEER_BROWSER_BRIDGE_TOKEN: true,
  OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN: true,
  OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN: true,
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN: true,
});

export const KubernetesManagedDeploymentTemplateSchema = z.strictObject({
  browserRuntimeImage: PinnedImageSchema,
  browserEgressImage: PinnedImageSchema,
  channelRuntimeImage: PinnedImageSchema,
  filesImage: PinnedImageSchema,
  fuseResourceName: z
    .string()
    .regex(/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?\/[A-Za-z0-9][-A-Za-z0-9_.]{0,62}$/u),
  hostImage: PinnedImageSchema,
  ingressSourceCidrs: z.array(z.cidrv4()).max(16),
  kubernetesApiServer: z
    .url()
    .startsWith("https://")
    .refine((value) => new URL(value).origin === value, "Kubernetes API server must be an origin"),
  kubernetesCa: z
    .string()
    .min(1)
    .max(65_536)
    .refine(
      (value) =>
        value.includes("-----BEGIN CERTIFICATE-----") &&
        value.includes("-----END CERTIFICATE-----"),
      "Kubernetes CA must be a PEM certificate",
    ),
  namespacePrefix: z.string().regex(/^[a-z][a-z0-9-]{0,20}$/u),
  postgresImage: PinnedImageSchema,
  portableFsMountImage: PinnedImageSchema,
  portableFsMountSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  portableFsManagerUrl: z.url().startsWith("https://"),
  portableFsManagerCidrs: z.array(z.cidrv4()).min(1).max(16),
  portableFsManagerCa: z.string().min(1).max(65_536),
  portableFsManagerCertificate: z.string().min(1).max(65_536),
  portableFsManagerPrivateKey: z.string().min(1).max(65_536),
  portableFsProductPrivateKey: z.string().min(1).max(65_536),
  portableFsProductIssuer: z.string().trim().min(1).max(255),
  portableFsServiceId: z.string().trim().min(1).max(255),
  runnerImage: PinnedImageSchema,
  storageClassName: z.string().trim().min(1).max(253),
  version: z.literal(1),
});
export type KubernetesManagedDeploymentTemplate = z.infer<
  typeof KubernetesManagedDeploymentTemplateSchema
>;

/**
 * Kubernetes judges a rollout stuck after this long: four times the worst cold start observed
 * (~2.5 minutes for the browser runtime, including node scale-up and its large image pull), half
 * the operation's 20 minute bound, and the Kubernetes default, so nothing regresses by naming it.
 */
export const managedProgressDeadlineSeconds = 600;

export const managedWorkloads = [
  "postgres",
  "host",
  "runner",
  "browser-egress",
  "browser-runtime",
  "channel-runtime",
] as const;

export type ManagedWorkload = (typeof managedWorkloads)[number];

const managedWorkloadLabels: Readonly<Record<ManagedWorkload, string>> = {
  postgres: "Database",
  host: "Host",
  runner: "Runner",
  "browser-egress": "Browser egress",
  "browser-runtime": "Browser",
  "channel-runtime": "Messaging",
};

/** The name a person reads in the portal; workload names are Kubernetes identifiers. */
export function managedWorkloadLabel(workload: string): string {
  return managedWorkloadLabels[workload as ManagedWorkload] ?? workload;
}

/**
 * The snapshot pins where a deployment lives and what can never move under it: the hosting
 * cluster and its trust, the namespace name, the immutable PVC storage class, the cluster's FUSE
 * resource, the PostgreSQL major version (a bump would refuse the existing data directory), and
 * the PortableFS identity that names its existing volumes. Everything else is the release and
 * comes from the live template at reconcile time so a deployment converges to the current build.
 */
export const KubernetesManagedDeploymentPlacementSchema = z.object(
  KubernetesManagedDeploymentTemplateSchema.pick({
    fuseResourceName: true,
    kubernetesApiServer: true,
    kubernetesCa: true,
    namespacePrefix: true,
    portableFsProductIssuer: true,
    portableFsServiceId: true,
    postgresImage: true,
    storageClassName: true,
    version: true,
  }).shape,
);
export type KubernetesManagedDeploymentPlacement = z.infer<
  typeof KubernetesManagedDeploymentPlacementSchema
>;

const placementKeys = Object.keys(
  KubernetesManagedDeploymentPlacementSchema.shape,
) as readonly (keyof KubernetesManagedDeploymentPlacement)[];

/** Rows written before the split carry a whole template; the extra keys are stripped, not honoured. */
export function managedDeploymentPlacement(
  snapshot: unknown,
): KubernetesManagedDeploymentPlacement {
  return KubernetesManagedDeploymentPlacementSchema.parse(snapshot);
}

export function managedDeploymentOperationTemplate(
  placement: KubernetesManagedDeploymentPlacement,
  live: KubernetesManagedDeploymentTemplate,
): KubernetesManagedDeploymentTemplate {
  return KubernetesManagedDeploymentTemplateSchema.parse({ ...live, ...placement });
}

/**
 * A stable identifier for the release half of the live template: every field a deployment is
 * expected to converge to. Equal identifiers mean re-applying would change nothing.
 */
export function managedDeploymentRelease(template: KubernetesManagedDeploymentTemplate): string {
  const release = Object.fromEntries(
    Object.entries(template)
      .filter(([key]) => !placementKeys.includes(key as keyof KubernetesManagedDeploymentPlacement))
      .sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(release)).digest("hex")}`;
}

export function managedDeploymentNamespace(
  prefix: string,
  deploymentId: DeploymentId | string,
): string {
  return `${prefix}-${DeploymentIdSchema.parse(deploymentId).slice(4).replaceAll("-", "")}`;
}

export function kubernetesManagedDeploymentResources(input: {
  readonly purpose?: "teardown";
  readonly canonicalOrigin: string;
  readonly deploymentId: DeploymentId;
  readonly name: string;
  readonly namespace: string;
  readonly operationId: string;
  readonly secrets: Readonly<Record<string, string>>;
  readonly template: KubernetesManagedDeploymentTemplate;
}): readonly KubernetesObject[] {
  const canonicalOrigin = new URL(input.canonicalOrigin);
  if (
    canonicalOrigin.protocol !== "https:" ||
    canonicalOrigin.username ||
    canonicalOrigin.password ||
    canonicalOrigin.pathname !== "/" ||
    canonicalOrigin.search ||
    canonicalOrigin.hash
  ) {
    throw new Error("Managed Deployment canonical origin must be a bare HTTPS origin.");
  }
  const runtimeSecrets =
    input.purpose === "teardown" ? null : ManagedRuntimeSecretsSchema.parse(input.secrets);
  const secrets = ManagedTeardownSecretsSchema.parse(input.secrets);
  const labels = {
    "app.kubernetes.io/managed-by": "opensteer-control-plane",
    "opensteer.dev/deployment-id": input.deploymentId,
  };
  const podSecurity = { seccompProfile: { type: "RuntimeDefault" } };
  const containerSecurity = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
    runAsGroup: 10001,
    runAsNonRoot: true,
    runAsUser: 10001,
  };
  const pvc = (name: string, storage: string): KubernetesObject => ({
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { labels, name, namespace: input.namespace },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage } },
      storageClassName: input.template.storageClassName,
    },
  });
  const deployment = (
    name: (typeof managedWorkloads)[number],
    container: Readonly<Record<string, unknown>>,
    volumes: readonly unknown[] = [],
    workloadPodSecurity: Readonly<Record<string, unknown>> = podSecurity,
    writableVolumeNames: readonly string[] = [],
  ): KubernetesObject => ({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { labels, name, namespace: input.namespace },
    spec: {
      progressDeadlineSeconds: managedProgressDeadlineSeconds,
      replicas: 1,
      selector: { matchLabels: { "app.kubernetes.io/name": name } },
      strategy: { type: "Recreate" },
      template: {
        metadata: {
          annotations: { "opensteer.dev/operation-id": input.operationId },
          labels: { "app.kubernetes.io/name": name },
        },
        spec: {
          automountServiceAccountToken: false,
          containers: [container],
          ...(writableVolumeNames.length > 0 || name === "runner"
            ? {
                initContainers: [
                  ...(writableVolumeNames.length > 0
                    ? [
                        {
                          args: [
                            `chown 10001:10001 ${writableVolumeNames.map((volumeName) => `/volumes/${volumeName}`).join(" ")} && chmod 0700 ${writableVolumeNames.map((volumeName) => `/volumes/${volumeName}`).join(" ")}`,
                          ],
                          command: ["/bin/sh", "-ec"],
                          image: input.template.portableFsMountImage,
                          name: "initialize-runtime-volumes",
                          securityContext: {
                            allowPrivilegeEscalation: false,
                            capabilities: { add: ["CHOWN", "FOWNER"], drop: ["ALL"] },
                            readOnlyRootFilesystem: true,
                            runAsGroup: 0,
                            runAsNonRoot: false,
                            runAsUser: 0,
                          },
                          volumeMounts: writableVolumeNames.map((volumeName) => ({
                            mountPath: `/volumes/${volumeName}`,
                            name: volumeName,
                          })),
                        },
                      ]
                    : []),
                  ...(name === "runner"
                    ? [
                        {
                          args: [
                            `printf '%s  %s\n' '${input.template.portableFsMountSha256.slice(7)}' /portablefs/portablefs | sha256sum --check --strict && cp /portablefs/portablefs /opt/portablefs/portablefs && chmod 0555 /opt/portablefs/portablefs`,
                          ],
                          command: ["/bin/sh", "-ec"],
                          image: input.template.portableFsMountImage,
                          name: "install-portablefs",
                          securityContext: containerSecurity,
                          volumeMounts: [{ mountPath: "/opt/portablefs", name: "portablefs" }],
                        },
                      ]
                    : []),
                ],
              }
            : {}),
          securityContext: workloadPodSecurity,
          terminationGracePeriodSeconds: 90,
          volumes,
        },
      },
    },
  });
  const secretValue = (name: string) => ({
    name,
    valueFrom: { secretKeyRef: { key: name, name: "runtime" } },
  });
  return [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        annotations: { "opensteer.dev/operation-id": input.operationId },
        labels,
        name: input.namespace,
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        annotations: { "opensteer.dev/operation-id": input.operationId },
        labels,
        name: "runtime",
        namespace: input.namespace,
      },
      stringData: {
        "account-bundle.json": secrets["account-bundle.json"],
        "credential.key": secrets["credential.key"],
        "host-private.pem": secrets["host-private.pem"],
        "host-public.pem": secrets["host-public.pem"],
        OPENSTEER_AUTH_SECRET: secrets.OPENSTEER_AUTH_SECRET,
        ...(runtimeSecrets
          ? {
              OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN:
                runtimeSecrets.OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN,
              OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN:
                runtimeSecrets.OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN,
            }
          : {}),
        OPENSTEER_DATABASE_URL: `postgresql://postgres:${secrets.POSTGRES_PASSWORD}@postgres:5432/postgres`,
        "portablefs-ca.pem": input.template.portableFsManagerCa,
        "portablefs-client.pem": input.template.portableFsManagerCertificate,
        "portablefs-client-key.pem": input.template.portableFsManagerPrivateKey,
        "portablefs-product.pem": input.template.portableFsProductPrivateKey,
      },
    },
    ...(runtimeSecrets
      ? [
          {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { labels, name: "runner-enrollment", namespace: input.namespace },
            stringData: {
              OPENSTEER_RUNNER_ENROLLMENT_TOKEN: runtimeSecrets.OPENSTEER_RUNNER_ENROLLMENT_TOKEN,
            },
          },
          {
            apiVersion: "v1",
            // Each module-only computer gets its own Secret so a pod only ever holds
            // the one-use credential for the machine it is.
            kind: "Secret",
            metadata: { labels, name: "browser-enrollment", namespace: input.namespace },
            stringData: {
              OPENSTEER_BROWSER_BRIDGE_TOKEN: runtimeSecrets.OPENSTEER_BROWSER_BRIDGE_TOKEN,
              OPENSTEER_RUNNER_ENROLLMENT_TOKEN:
                runtimeSecrets.OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN,
            },
          },
          {
            apiVersion: "v1",
            kind: "Secret",
            metadata: { labels, name: "messaging-enrollment", namespace: input.namespace },
            stringData: {
              OPENSTEER_RUNNER_ENROLLMENT_TOKEN:
                runtimeSecrets.OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN,
            },
          },
        ]
      : []),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { labels, name: "postgres-password", namespace: input.namespace },
      stringData: { POSTGRES_PASSWORD: secrets.POSTGRES_PASSWORD },
    },
    {
      apiVersion: "v1",
      // The Host's public key, so the files service can verify what the Host
      // signed. It is public material, which is why it is mounted and never
      // treated as a credential.
      kind: "Secret",
      metadata: { labels, name: "browser-trust", namespace: input.namespace },
      stringData: { "host-public.pem": secrets["host-public.pem"] },
    },

    pvc("postgres-data", "20Gi"),
    pvc("host-data", "10Gi"),
    pvc("files-data", "20Gi"),
    pvc("runner-data", "10Gi"),
    pvc("browser-data", "10Gi"),
    pvc("channel-data", "10Gi"),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { labels, name: "postgres", namespace: input.namespace },
      spec: {
        ports: [{ name: "postgres", port: 5432 }],
        selector: { "app.kubernetes.io/name": "postgres" },
      },
    },
    deployment(
      "postgres",
      {
        env: [
          {
            name: "POSTGRES_PASSWORD",
            valueFrom: {
              secretKeyRef: { key: "POSTGRES_PASSWORD", name: "postgres-password" },
            },
          },
        ],
        image: input.template.postgresImage,
        name: "postgres",
        ports: [{ containerPort: 5432, name: "postgres" }],
        readinessProbe: { exec: { command: ["pg_isready", "-U", "postgres"] }, periodSeconds: 5 },
        resources: { requests: { cpu: "250m", memory: "512Mi" } },
        securityContext: {
          ...containerSecurity,
          readOnlyRootFilesystem: false,
          runAsGroup: 999,
          runAsUser: 999,
        },
        volumeMounts: [{ mountPath: "/var/lib/postgresql", name: "data" }],
      },
      [{ name: "data", persistentVolumeClaim: { claimName: "postgres-data" } }],
      { fsGroup: 999, seccompProfile: { type: "RuntimeDefault" } },
    ),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { labels, name: "host", namespace: input.namespace },
      spec: {
        ports: [{ name: "http", port: 4310, targetPort: "http" }],
        selector: { "app.kubernetes.io/name": "host" },
      },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { labels, name: "host", namespace: input.namespace },
      spec: {
        progressDeadlineSeconds: managedProgressDeadlineSeconds,
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "host" } },
        strategy: { type: "Recreate" },
        template: {
          metadata: {
            annotations: { "opensteer.dev/operation-id": input.operationId },
            labels: { "app.kubernetes.io/name": "host" },
          },
          spec: {
            automountServiceAccountToken: false,
            initContainers: [
              {
                args: [
                  "chown 10001:10001 /run/opensteer /var/lib/opensteer && chmod 0700 /run/opensteer /var/lib/opensteer && chmod 1777 /var/lib/portablefs-files && cp /staged-trust/host-public.pem /files-trust/host-public.pem && chmod 0444 /files-trust/host-public.pem",
                ],
                command: ["/bin/sh", "-ec"],
                image: input.template.portableFsMountImage,
                name: "initialize-host-volumes",
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { add: ["CHOWN", "FOWNER"], drop: ["ALL"] },
                  readOnlyRootFilesystem: true,
                  runAsGroup: 0,
                  runAsNonRoot: false,
                  runAsUser: 0,
                },
                volumeMounts: [
                  { mountPath: "/var/lib/opensteer", name: "host-data" },
                  { mountPath: "/var/lib/portablefs-files", name: "files-data" },
                  { mountPath: "/run/opensteer", name: "runtime" },
                  { mountPath: "/tmp", name: "tmp" },
                  { mountPath: "/staged-trust", name: "staged-files-trust", readOnly: true },
                  { mountPath: "/files-trust", name: "files-trust" },
                ],
              },
              {
                args: ["node", "dist/stage-managed-secrets-main.js"],
                image: input.template.hostImage,
                name: "stage-host-secrets",
                resources: { requests: { cpu: "25m", memory: "64Mi" } },
                securityContext: containerSecurity,
                volumeMounts: [
                  { mountPath: "/staged", name: "staged-runtime", readOnly: true },
                  { mountPath: "/run/opensteer", name: "runtime" },
                ],
              },
            ],
            containers: [
              {
                env: [
                  secretValue("OPENSTEER_AUTH_SECRET"),
                  secretValue("OPENSTEER_DATABASE_URL"),
                  { name: "OPENSTEER_BIND_ADDRESS", value: "0.0.0.0" },
                  { name: "OPENSTEER_CANONICAL_ORIGIN", value: input.canonicalOrigin },
                  { name: "OPENSTEER_DEPLOYMENT_NAME", value: input.name },
                  { name: "OPENSTEER_DEPLOYMENT_KIND", value: "server" },
                  { name: "OPENSTEER_FILES_SERVICE_URL", value: "http://127.0.0.1:4315" },
                  { name: "OPENSTEER_HOST_DATA_DIR", value: "/var/lib/opensteer" },
                  {
                    name: "OPENSTEER_HOST_PRIVATE_KEY_PATH",
                    value: "/run/opensteer/host-private.pem",
                  },
                  {
                    name: "OPENSTEER_HOST_PUBLIC_KEY_PATH",
                    value: "/run/opensteer/host-public.pem",
                  },
                  {
                    name: "OPENSTEER_ACCOUNT_BUNDLE_PATH",
                    value: "/run/opensteer/account-bundle.json",
                  },
                  { name: "OPENSTEER_CREDENTIAL_KEY_PATH", value: "/run/opensteer/credential.key" },
                  { name: "OPENSTEER_BROWSER_ATTACH_KEY_ID", value: "host-v1" },
                  { name: "OPENSTEER_RUNTIME_ORIGIN", value: input.canonicalOrigin },
                  { name: "OPENSTEER_SIGNUP_POLICY", value: "invite-only" },
                  {
                    name: "OPENSTEER_INITIAL_BROWSER_RUNNER_ENROLLMENT_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        key: "OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN",
                        name: "runtime",
                      },
                    },
                  },
                  {
                    name: "OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN",
                    valueFrom: {
                      secretKeyRef: {
                        key: "OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN",
                        name: "runtime",
                      },
                    },
                  },
                  { name: "OPENSTEER_MODE", value: "production" },
                  { name: "OPENSTEER_PORT", value: "4310" },
                  {
                    name: hostEnvironmentKeys.defaultWorkspaceBacking,
                    value: "portablefs",
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN",
                    value: input.deploymentId,
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_MANAGER_URL",
                    value: input.template.portableFsManagerUrl,
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_SERVICE_ID",
                    value: input.template.portableFsServiceId,
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_PRODUCT_ISSUER",
                    value: input.template.portableFsProductIssuer,
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_MANAGER_CA_PATH",
                    value: "/run/opensteer/portablefs-ca.pem",
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH",
                    value: "/run/opensteer/portablefs-client.pem",
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH",
                    value: "/run/opensteer/portablefs-client-key.pem",
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH",
                    value: "/run/opensteer/portablefs-product.pem",
                  },
                ],
                image: input.template.hostImage,
                name: "host",
                ports: [{ containerPort: 4310, name: "http" }],
                readinessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 5 },
                resources: { requests: { cpu: "500m", memory: "1Gi" } },
                securityContext: containerSecurity,
                volumeMounts: [
                  { mountPath: "/var/lib/opensteer", name: "host-data" },
                  { mountPath: "/run/opensteer", name: "runtime" },
                  { mountPath: "/tmp", name: "tmp" },
                ],
              },
              {
                args: [
                  "--request-public-key",
                  "/run/opensteer/host-public.pem",
                  "--request-issuer",
                  "opensteer-host",
                  "--identity-dir",
                  "/var/lib/portablefs-files/identity",
                  "--listen",
                  "127.0.0.1:4315",
                ],
                image: input.template.filesImage,
                name: "files",
                readinessProbe: {
                  exec: {
                    command: ["curl", "--fail", "--silent", "http://127.0.0.1:4315/healthz"],
                  },
                  periodSeconds: 5,
                },
                resources: { requests: { cpu: "100m", memory: "256Mi" } },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ["ALL"] },
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                },
                volumeMounts: [
                  { mountPath: "/var/lib/portablefs-files", name: "files-data" },
                  { mountPath: "/run/opensteer", name: "files-trust", readOnly: true },
                ],
              },
            ],
            securityContext: { seccompProfile: { type: "RuntimeDefault" } },
            volumes: [
              { name: "host-data", persistentVolumeClaim: { claimName: "host-data" } },
              { name: "files-data", persistentVolumeClaim: { claimName: "files-data" } },
              { name: "runtime", emptyDir: {} },
              {
                name: "staged-runtime",
                secret: { defaultMode: 292, secretName: "runtime" },
              },
              { name: "files-trust", emptyDir: {} },
              {
                name: "staged-files-trust",
                secret: { defaultMode: 292, secretName: "browser-trust" },
              },
              { name: "tmp", emptyDir: {} },
            ],
          },
        },
      },
    },
    deployment(
      "runner",
      {
        env: managedRunnerEnvironment(input.canonicalOrigin, input.template.portableFsMountSha256),
        image: input.template.runnerImage,
        name: "runner",
        readinessProbe: {
          exec: {
            command: [
              "node",
              "-e",
              "const x=JSON.parse(require('node:fs').readFileSync('/var/lib/opensteer/ready.json'));if(x.version!==1||x.state!=='connected'||!Number.isSafeInteger(x.pid)){process.exit(1)}process.kill(x.pid,0)",
            ],
          },
          periodSeconds: 5,
        },
        resources: {
          limits: { [input.template.fuseResourceName]: "1" },
          requests: { cpu: "1", memory: "2Gi", [input.template.fuseResourceName]: "1" },
        },
        securityContext: {
          allowPrivilegeEscalation: true,
          appArmorProfile: { type: "Unconfined" },
          capabilities: { add: ["DAC_READ_SEARCH", "SYS_ADMIN"], drop: ["ALL"] },
          seccompProfile: {
            localhostProfile: "opensteer/runner.json",
            type: "Localhost",
          },
        },
        volumeMounts: [
          { mountPath: "/opt/portablefs", name: "portablefs", readOnly: true },
          { mountPath: "/var/lib/opensteer", name: "data" },
          { mountPath: "/workspaces", name: "workspaces" },
        ],
      },
      [
        { name: "data", persistentVolumeClaim: { claimName: "runner-data" } },
        { emptyDir: {}, name: "portablefs" },
        { emptyDir: {}, name: "workspaces" },
      ],
      podSecurity,
      ["data", "portablefs", "workspaces"],
    ),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { labels, name: "browser-egress", namespace: input.namespace },
      spec: {
        ports: [{ name: "http", port: 4313 }],
        selector: { "app.kubernetes.io/name": "browser-egress" },
      },
    },
    deployment("browser-egress", {
      env: [
        { name: "OPENSTEER_BROWSER_EGRESS_HOST", value: "0.0.0.0" },
        { name: "OPENSTEER_BROWSER_EGRESS_PORT", value: "4313" },
      ],
      image: input.template.browserEgressImage,
      name: "browser-egress",
      ports: [{ containerPort: 4313, name: "http" }],
      readinessProbe: { httpGet: { path: "/health", port: "http" }, periodSeconds: 5 },
      resources: { requests: { cpu: "100m", memory: "128Mi" } },
      securityContext: containerSecurity,
    }),
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: { labels, name: "browser-egress-only", namespace: input.namespace },
      spec: {
        ports: [{ name: "http", port: 4313 }],
        selector: { "app.kubernetes.io/name": "browser-egress" },
      },
    },
    deployment(
      "browser-runtime",
      {
        // The browser pod is a browser-only Runner: it enrolls, dials the
        // canonical TLS origin, and relays into its Chromium over loopback.
        env: managedBrowserRuntimeEnvironment(input.canonicalOrigin),
        image: input.template.browserRuntimeImage,
        name: "browser-runtime",
        resources: { requests: { cpu: "500m", memory: "1Gi" } },
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: { add: ["SYS_CHROOT"], drop: ["ALL"] },
          readOnlyRootFilesystem: true,
          runAsGroup: 10001,
          runAsNonRoot: true,
          runAsUser: 10001,
          seccompProfile: {
            localhostProfile: "opensteer/chromium.json",
            type: "Localhost",
          },
        },
        volumeMounts: [
          { mountPath: "/dev/shm", name: "shm" },
          { mountPath: "/home/opensteer", name: "home" },
          { mountPath: "/var/lib/opensteer", name: "data" },
          { mountPath: "/tmp", name: "tmp" },
        ],
      },
      [
        { name: "data", persistentVolumeClaim: { claimName: "browser-data" } },
        { emptyDir: { medium: "Memory", sizeLimit: "256Mi" }, name: "home" },
        { emptyDir: { medium: "Memory", sizeLimit: "1Gi" }, name: "shm" },
        { emptyDir: {}, name: "tmp" },
      ],
      podSecurity,
      ["data", "home", "shm", "tmp"],
    ),
    deployment(
      "channel-runtime",
      {
        env: [
          {
            name: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
            valueFrom: {
              secretKeyRef: {
                key: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
                name: "messaging-enrollment",
              },
            },
          },
          { name: "OPENSTEER_MESSAGING_HOST_URL", value: input.canonicalOrigin },
          { name: "OPENSTEER_MESSAGING_BIND_ADDRESS", value: "0.0.0.0" },
          { name: "OPENSTEER_MESSAGING_DATA_DIR", value: "/var/lib/opensteer" },
          { name: "OPENSTEER_MESSAGING_NAME", value: "Hosted messaging service" },
          { name: "OPENSTEER_MESSAGING_PORT", value: "4320" },
          { name: "OPENSTEER_MODE", value: "production" },
        ],
        image: input.template.channelRuntimeImage,
        name: "channel-runtime",
        ports: [{ containerPort: 4320, name: "health" }],
        readinessProbe: { httpGet: { path: "/readyz", port: "health" }, periodSeconds: 5 },
        resources: { requests: { cpu: "100m", memory: "256Mi" } },
        securityContext: containerSecurity,
        volumeMounts: [{ mountPath: "/var/lib/opensteer", name: "data" }],
      },
      [{ name: "data", persistentVolumeClaim: { claimName: "channel-data" } }],
      podSecurity,
      ["data"],
    ),
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { labels, name: "tenant-isolation", namespace: input.namespace },
      spec: {
        egress: [
          { to: [{ podSelector: {} }] },
          {
            ports: [
              { port: 53, protocol: "UDP" },
              { port: 53, protocol: "TCP" },
            ],
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
              },
            ],
          },
          {
            to: [
              {
                ipBlock: {
                  cidr: "0.0.0.0/0",
                  except: [
                    "10.0.0.0/8",
                    "100.64.0.0/10",
                    "127.0.0.0/8",
                    "169.254.0.0/16",
                    "172.16.0.0/12",
                    "192.168.0.0/16",
                  ],
                },
              },
            ],
          },
        ],
        ingress: [
          { from: [{ podSelector: {} }] },
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "opensteer.dev/role": "hosting-system" },
                },
                podSelector: {
                  matchLabels: { "app.kubernetes.io/name": "hosting-router" },
                },
              },
            ],
          },
          ...(input.template.ingressSourceCidrs.length > 0
            ? [
                {
                  from: input.template.ingressSourceCidrs.map((cidr) => ({ ipBlock: { cidr } })),
                },
              ]
            : []),
        ],
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: { labels, name: "host-portablefs-egress", namespace: input.namespace },
      spec: {
        egress: [
          {
            to: input.template.portableFsManagerCidrs.map((cidr) => ({ ipBlock: { cidr } })),
          },
        ],
        podSelector: {
          matchExpressions: [
            {
              key: "app.kubernetes.io/name",
              operator: "In",
              // The mount daemon renews its enrollment directly with Manager.
              // Initial authorization through Host alone cannot keep a mount live.
              values: ["host", "runner", "managed-teardown"],
            },
          ],
        },
        policyTypes: ["Egress"],
      },
    },
  ];
}

export function kubernetesManagedTeardownJob(input: {
  readonly deploymentId: DeploymentId;
  readonly canonicalOrigin: string;
  readonly name: string;
  readonly namespace: string;
  readonly operationId: string;
  readonly template: KubernetesManagedDeploymentTemplate;
  readonly teardownImage: KubernetesManagedDeploymentTemplate["hostImage"];
}): KubernetesObject {
  const secretValue = (name: string) => ({
    name,
    valueFrom: { secretKeyRef: { key: name, name: "runtime" } },
  });
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      labels: { "app.kubernetes.io/managed-by": "opensteer-control-plane" },
      name: "managed-teardown",
      namespace: input.namespace,
    },
    spec: {
      backoffLimit: 3,
      template: {
        metadata: {
          annotations: { "opensteer.dev/operation-id": input.operationId },
          labels: { "app.kubernetes.io/name": "managed-teardown" },
        },
        spec: {
          automountServiceAccountToken: false,
          initContainers: [
            {
              args: ["chown 10001:10001 /run/opensteer && chmod 0700 /run/opensteer"],
              command: ["/bin/sh", "-ec"],
              image: input.template.portableFsMountImage,
              name: "initialize-runtime-volume",
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { add: ["CHOWN", "FOWNER"], drop: ["ALL"] },
                readOnlyRootFilesystem: true,
                runAsGroup: 0,
                runAsNonRoot: false,
                runAsUser: 0,
              },
              volumeMounts: [{ mountPath: "/run/opensteer", name: "runtime" }],
            },
            {
              args: ["node", "dist/stage-managed-secrets-main.js"],
              image: input.teardownImage,
              name: "stage-host-secrets",
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
                runAsGroup: 10001,
                runAsNonRoot: true,
                runAsUser: 10001,
              },
              volumeMounts: [
                { mountPath: "/staged", name: "staged-runtime", readOnly: true },
                { mountPath: "/run/opensteer", name: "runtime" },
              ],
            },
          ],
          containers: [
            {
              args: ["node", "dist/destroy-managed-main.js", input.deploymentId],
              env: [
                secretValue("OPENSTEER_AUTH_SECRET"),
                secretValue("OPENSTEER_DATABASE_URL"),
                {
                  name: "OPENSTEER_ACCOUNT_BUNDLE_PATH",
                  value: "/run/opensteer/account-bundle.json",
                },
                { name: "OPENSTEER_BIND_ADDRESS", value: "127.0.0.1" },
                { name: "OPENSTEER_CANONICAL_ORIGIN", value: input.canonicalOrigin },
                { name: "OPENSTEER_CREDENTIAL_KEY_PATH", value: "/run/opensteer/credential.key" },
                { name: "OPENSTEER_DEPLOYMENT_KIND", value: "server" },
                { name: "OPENSTEER_DEPLOYMENT_NAME", value: input.name },
                { name: "OPENSTEER_FILES_SERVICE_URL", value: "http://127.0.0.1:4315" },
                { name: "OPENSTEER_HOST_DATA_DIR", value: "/var/lib/opensteer" },
                {
                  name: "OPENSTEER_HOST_PRIVATE_KEY_PATH",
                  value: "/run/opensteer/host-private.pem",
                },
                { name: "OPENSTEER_HOST_PUBLIC_KEY_PATH", value: "/run/opensteer/host-public.pem" },
                { name: "OPENSTEER_MODE", value: "production" },
                { name: "OPENSTEER_PORTABLEFS_AUTHORIZATION_DOMAIN", value: input.deploymentId },
                {
                  name: "OPENSTEER_PORTABLEFS_MANAGER_CA_PATH",
                  value: "/run/opensteer/portablefs-ca.pem",
                },
                {
                  name: "OPENSTEER_PORTABLEFS_MANAGER_CERT_PATH",
                  value: "/run/opensteer/portablefs-client.pem",
                },
                {
                  name: "OPENSTEER_PORTABLEFS_MANAGER_KEY_PATH",
                  value: "/run/opensteer/portablefs-client-key.pem",
                },
                {
                  name: "OPENSTEER_PORTABLEFS_MANAGER_URL",
                  value: input.template.portableFsManagerUrl,
                },
                {
                  name: "OPENSTEER_PORTABLEFS_PRODUCT_ISSUER",
                  value: input.template.portableFsProductIssuer,
                },
                {
                  name: "OPENSTEER_PORTABLEFS_PRODUCT_PRIVATE_KEY_PATH",
                  value: "/run/opensteer/portablefs-product.pem",
                },
                {
                  name: "OPENSTEER_PORTABLEFS_SERVICE_ID",
                  value: input.template.portableFsServiceId,
                },
                { name: "OPENSTEER_PORT", value: "4310" },
                { name: "OPENSTEER_RUNTIME_ORIGIN", value: input.canonicalOrigin },
                { name: "OPENSTEER_SIGNUP_POLICY", value: "invite-only" },
                {
                  name: hostEnvironmentKeys.defaultWorkspaceBacking,
                  value: "portablefs",
                },
              ],
              image: input.teardownImage,
              name: "teardown",
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
                readOnlyRootFilesystem: true,
                runAsGroup: 10001,
                runAsNonRoot: true,
                runAsUser: 10001,
              },
              volumeMounts: [
                { mountPath: "/run/opensteer", name: "runtime", readOnly: true },
                { mountPath: "/tmp", name: "tmp" },
              ],
            },
          ],
          restartPolicy: "Never",
          securityContext: { seccompProfile: { type: "RuntimeDefault" } },
          volumes: [
            { name: "runtime", emptyDir: {} },
            { name: "staged-runtime", secret: { defaultMode: 292, secretName: "runtime" } },
            { name: "tmp", emptyDir: {} },
          ],
        },
      },
    },
  };
}
