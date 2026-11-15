import { createId } from "@opensteer/core";
import { createHash, randomBytes, generateKeyPairSync } from "node:crypto";
import {
  hostedTeamOrigin,
  type HostedTeamSlug,
} from "@opensteer/control-plane-protocol/hosted-teams";

/** Everything the provisioner creates is labelled so it can find its own work, and only that. */
export const managedByLabel = "app.kubernetes.io/managed-by";
export const managedBy = "opensteer-team-provisioner";
export const teamIdLabel = "opensteer.dev/hosted-team-id";
/** The rendered template's digest, recorded last so a partial apply is retried. */
export const appliedHashAnnotation = "opensteer.dev/applied-hash";
export const setupGenerationAnnotation = "opensteer.dev/setup-generation";
export const edgeNamespace = "opensteer-teams-edge";
export const teamSecretName = "team";
export const teamObjectName = "team";

const storageLimitBytes = 5 * 1024 ** 3;
const opensteerUid = 10_001;
const hostPort = 4310;

export interface TeamImages {
  readonly host: string;
}

export interface TeamTemplateInput {
  readonly id: string;
  readonly slug: HostedTeamSlug;
  readonly name: string;
  readonly images: TeamImages;
  readonly platform: TeamPlatform;
  readonly replicas: number;
  readonly setupGeneration: number;
}

export type KubernetesObject = {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: {
    readonly name: string;
    readonly namespace?: string;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
  };
} & Readonly<Record<string, unknown>>;

export function teamNamespace(slug: HostedTeamSlug): string {
  return `team-${slug}`;
}

export function renderTeam(input: TeamTemplateInput): readonly KubernetesObject[] {
  const namespace = teamNamespace(input.slug);
  const labels = { [managedByLabel]: managedBy, [teamIdLabel]: input.id };
  const meta = (name: string) => ({ name, namespace, labels });
  const objects: KubernetesObject[] = [
    {
      apiVersion: "v1",
      kind: "Namespace",
      metadata: {
        name: namespace,
        labels: {
          ...labels,
          "pod-security.kubernetes.io/enforce": "restricted",
          "pod-security.kubernetes.io/enforce-version": "latest",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "ResourceQuota",
      metadata: meta(teamObjectName),
      spec: {
        hard: {
          pods: String(Math.max(3, input.replicas + 2)),
          "requests.cpu": "2",
          "requests.memory": "4Gi",
          persistentvolumeclaims: "0",
          services: "1",
          "services.loadbalancers": "0",
          "services.nodeports": "0",
          secrets: "2",
          configmaps: "2",
        },
      },
    },
    {
      apiVersion: "v1",
      kind: "LimitRange",
      metadata: meta(teamObjectName),
      spec: {
        limits: [{ type: "Container", max: { cpu: "2", memory: "2Gi" } }],
      },
    },
    {
      apiVersion: "networking.k8s.io/v1",
      kind: "NetworkPolicy",
      metadata: meta(teamObjectName),
      spec: {
        podSelector: {},
        policyTypes: ["Ingress", "Egress"],
        ingress: [
          {
            from: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": edgeNamespace },
                },
              },
            ],
            ports: [{ protocol: "TCP", port: hostPort }],
          },
        ],
        egress: [
          {
            to: [{ ipBlock: { cidr: `${input.platform.databaseIp}/32` } }],
            ports: [{ protocol: "TCP", port: 5432 }],
          },
          {
            to: [{ ipBlock: { cidr: "169.254.169.254/32" } }],
            ports: [
              { protocol: "TCP", port: 80 },
              { protocol: "TCP", port: 8080 },
            ],
          },
          {
            to: [
              {
                namespaceSelector: {
                  matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
                },
                podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
              },
              // Pods resolve through GKE's NodeLocal DNSCache (or Cloud DNS on the metadata
              // address); only port 53 is reachable on either.
              { ipBlock: { cidr: "169.254.20.10/32" } },
              { ipBlock: { cidr: "169.254.169.254/32" } },
            ],
            ports: [
              { protocol: "UDP", port: 53 },
              { protocol: "TCP", port: 53 },
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
      },
    },
    {
      apiVersion: "v1",
      kind: "Service",
      metadata: meta(teamObjectName),
      spec: {
        selector: labels,
        ports: [{ name: "http", port: 80, targetPort: "host" }],
      },
    },
  ];
  objects.splice(1, 0, {
    apiVersion: "rbac.authorization.k8s.io/v1",
    kind: "RoleBinding",
    metadata: meta(teamObjectName),
    roleRef: {
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "team-installation-reader",
    },
    subjects: [{ kind: "ServiceAccount", name: "team-provisioner", namespace: "opensteer-teams" }],
  });
  objects.splice(2, 0, {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: meta(teamObjectName),
    automountServiceAccountToken: false,
  });
  const deployment = teamDeployment(input, meta(teamObjectName), labels);
  const hash = createHash("sha256")
    .update(JSON.stringify([...objects, deployment]))
    .digest("hex");
  return [
    ...objects,
    {
      ...deployment,
      metadata: { ...deployment.metadata, annotations: { [appliedHashAnnotation]: hash } },
    },
  ];
}

function teamDeployment(
  input: TeamTemplateInput,
  metadata: KubernetesObject["metadata"],
  labels: Readonly<Record<string, string>>,
): KubernetesObject {
  const restricted = (uid: number) => ({
    runAsNonRoot: true,
    runAsUser: uid,
    runAsGroup: uid,
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata,
    spec: {
      replicas: input.replicas,
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
      minReadySeconds: 10,
      selector: { matchLabels: labels },
      template: {
        metadata: {
          labels,
          annotations: { [setupGenerationAnnotation]: String(input.setupGeneration) },
        },
        spec: {
          serviceAccountName: "team",
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 90,
          securityContext: {
            runAsNonRoot: true,
            fsGroup: opensteerUid,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "host",
              image: input.images.host,
              env: [
                { name: "OPENSTEER_DEPLOYMENT_KIND", value: "team" },
                { name: "OPENSTEER_DEPLOYMENT_NAME", value: input.name },
                { name: "OPENSTEER_BIND_ADDRESS", value: "0.0.0.0" },
                { name: "OPENSTEER_PORT", value: "4310" },
                { name: "OPENSTEER_MODE", value: "production" },
                { name: "OPENSTEER_CANONICAL_ORIGIN", value: hostedTeamOrigin(input.slug) },
                { name: "OPENSTEER_DATABASE_URL_FILE", value: "/run/secrets/host/database-url" },
                { name: "OPENSTEER_AUTH_SECRET_FILE", value: "/run/secrets/host/auth-secret" },
                {
                  name: "OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST_FILE",
                  value: "/run/secrets/host/setup-token-digest",
                },
                { name: "OPENSTEER_TEAM_STORAGE_LIMIT_BYTES", value: String(storageLimitBytes) },
                { name: "OPENSTEER_HOST_DATA_DIR", value: "/tmp/host" },
                { name: "OPENSTEER_INSTALLATION_STRICT", value: "true" },
                {
                  name: "OPENSTEER_HOST_INSTANCE_ID_FILE",
                  value: "/run/secrets/host/host-instance-id",
                },
                { name: "OPENSTEER_TEAM_FILE_STORE", value: "gcs" },
                { name: "OPENSTEER_TEAM_GCS_BUCKET", value: input.platform.bucket },
                { name: "OPENSTEER_TEAM_GCS_PREFIX", value: `teams/${input.id}/` },
                {
                  name: "OPENSTEER_HOST_PRIVATE_KEY_PATH",
                  value: "/run/secrets/host/host-private.pem",
                },
                {
                  name: "OPENSTEER_HOST_PUBLIC_KEY_PATH",
                  value: "/run/secrets/host/host-public.pem",
                },
              ],
              ports: [{ name: "host", containerPort: 4310 }],
              readinessProbe: { httpGet: { path: "/readyz", port: "host" }, periodSeconds: 5 },
              livenessProbe: {
                httpGet: { path: "/healthz", port: "host" },
                initialDelaySeconds: 60,
                failureThreshold: 10,
                timeoutSeconds: 5,
                periodSeconds: 30,
              },
              resources: {
                requests: { cpu: "100m", memory: "320Mi" },
                limits: { memory: "768Mi" },
              },
              securityContext: restricted(opensteerUid),
              volumeMounts: [
                { name: "host-secret", mountPath: "/run/secrets/host", readOnly: true },
                { name: "host-tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            {
              name: "host-secret",
              secret: {
                secretName: teamSecretName,
                defaultMode: 0o440,
                items: [
                  ...[
                    "host-private.pem",
                    "host-public.pem",
                    "host-instance-id",
                    "database-ca.pem",
                  ].map((key) => ({ key, path: key })),
                  { key: "database-url", path: "database-url" },
                  { key: "auth-secret", path: "auth-secret" },
                  { key: "setup-token-digest", path: "setup-token-digest" },
                ],
              },
            },
            { name: "host-tmp", emptyDir: {} },
          ],
        },
      },
    },
  };
}

export function newTeamSecret(input: {
  readonly id: string;
  readonly slug: HostedTeamSlug;
  readonly setupTokenDigest: string;
  readonly databaseUrl: string;
  readonly databaseCa: string;
}): KubernetesObject {
  const keys = generateKeyPairSync("ed25519");
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: teamSecretName,
      namespace: teamNamespace(input.slug),
      labels: { [managedByLabel]: managedBy, [teamIdLabel]: input.id },
    },
    type: "Opaque",
    stringData: {
      "database-url": input.databaseUrl,
      "database-ca.pem": input.databaseCa,
      "host-private.pem": keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "host-public.pem": keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      "host-instance-id": createId("hostInstance"),
      "auth-secret": randomBytes(32).toString("base64url"),
      "setup-token-digest": input.setupTokenDigest,
    },
  };
}

export interface TeamPlatform {
  readonly databaseIp: string;
  readonly bucket: string;
}
