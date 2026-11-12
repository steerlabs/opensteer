import { createHash, randomBytes } from "node:crypto";
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

/** One volume holds the team's database and Host files; the Host refuses uploads past its cap. */
const volumeSize = "10Gi";
// Requests are sized from a measured idle team (Host ~150 MiB, Postgres ~80 MiB, gateway ~12 MiB,
// ~25m CPU in all); Autopilot bills requests, and the LimitRange lets CPU burst to 2 cores.
const storageLimitBytes = 5 * 1024 ** 3;
const postgresUid = 70;
const opensteerUid = 10_001;
/** Unprivileged; the team Service maps port 80 to it. */
const gatewayPort = 8080;

export interface TeamImages {
  readonly host: string;
  readonly gateway: string;
  readonly postgres: string;
}

export interface TeamTemplateInput {
  readonly id: string;
  readonly slug: HostedTeamSlug;
  readonly images: Pick<TeamImages, "gateway" | "host">;
  readonly postgresImage: string;
  readonly replicas: 0 | 1;
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

/**
 * The fixed shape of one hosted team: an isolated namespace that only the shared edge can reach,
 * holding one pod of Postgres, the team Host and its gateway. Objects are listed in apply order;
 * the StatefulSet comes last and carries the digest of everything before it.
 */
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
          pods: "2",
          "requests.cpu": "2",
          "requests.memory": "4Gi",
          "requests.storage": volumeSize,
          persistentvolumeclaims: "1",
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
        limits: [
          { type: "Container", max: { cpu: "2", memory: "2Gi" } },
          { type: "PersistentVolumeClaim", max: { storage: volumeSize } },
        ],
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
            ports: [{ protocol: "TCP", port: gatewayPort }],
          },
        ],
        egress: [
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
        ports: [{ name: "http", port: 80, targetPort: "http" }],
      },
    },
  ];
  const statefulSet = teamStatefulSet(input, meta(teamObjectName), labels);
  const hash = createHash("sha256")
    .update(JSON.stringify([...objects, statefulSet]))
    .digest("hex");
  return [
    ...objects,
    {
      ...statefulSet,
      metadata: { ...statefulSet.metadata, annotations: { [appliedHashAnnotation]: hash } },
    },
  ];
}

function teamStatefulSet(
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
    kind: "StatefulSet",
    metadata,
    spec: {
      replicas: input.replicas,
      serviceName: teamObjectName,
      // Ordered replacement: the old pod is gone before the new one starts, so two Hosts never
      // share one database.
      podManagementPolicy: "OrderedReady",
      updateStrategy: { type: "RollingUpdate" },
      persistentVolumeClaimRetentionPolicy: { whenDeleted: "Retain", whenScaled: "Retain" },
      selector: { matchLabels: labels },
      template: {
        metadata: {
          labels,
          annotations: { [setupGenerationAnnotation]: String(input.setupGeneration) },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          terminationGracePeriodSeconds: 60,
          securityContext: {
            runAsNonRoot: true,
            fsGroup: opensteerUid,
            // Postgres refuses a data directory whose group can write, so never re-chmod it.
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          initContainers: [
            {
              // A native sidecar: up before the Host starts, stopped only after the Host exits.
              name: "postgres",
              image: input.postgresImage,
              restartPolicy: "Always",
              args: ["-c", "listen_addresses=127.0.0.1"],
              env: [
                { name: "POSTGRES_USER", value: "opensteer" },
                { name: "POSTGRES_DB", value: "opensteer" },
                {
                  name: "POSTGRES_PASSWORD_FILE",
                  value: "/run/secrets/postgres/postgres-password",
                },
                { name: "PGDATA", value: "/data/postgres" },
              ],
              startupProbe: {
                exec: {
                  command: ["pg_isready", "-h", "127.0.0.1", "-U", "opensteer", "-d", "opensteer"],
                },
                periodSeconds: 2,
                failureThreshold: 150,
              },
              resources: {
                requests: { cpu: "50m", memory: "192Mi" },
                limits: { memory: "384Mi" },
              },
              securityContext: restricted(postgresUid),
              volumeMounts: [
                { name: "data", mountPath: "/data" },
                { name: "postgres-secret", mountPath: "/run/secrets/postgres", readOnly: true },
                { name: "postgres-run", mountPath: "/var/run/postgresql" },
                { name: "postgres-tmp", mountPath: "/tmp" },
              ],
            },
          ],
          containers: [
            {
              name: "host",
              image: input.images.host,
              env: [
                { name: "OPENSTEER_DEPLOYMENT_KIND", value: "team" },
                { name: "OPENSTEER_DEPLOYMENT_NAME", value: input.slug },
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
                { name: "OPENSTEER_HOST_DATA_DIR", value: "/data/host" },
                {
                  name: "OPENSTEER_HOST_PRIVATE_KEY_PATH",
                  value: "/data/host/keys/host-private.pem",
                },
                {
                  name: "OPENSTEER_HOST_PUBLIC_KEY_PATH",
                  value: "/data/host/keys/host-public.pem",
                },
              ],
              ports: [{ name: "host", containerPort: 4310 }],
              readinessProbe: { httpGet: { path: "/healthz", port: "host" }, periodSeconds: 5 },
              livenessProbe: {
                httpGet: { path: "/healthz", port: "host" },
                initialDelaySeconds: 60,
                periodSeconds: 30,
              },
              resources: { requests: { cpu: "100m", memory: "320Mi" }, limits: { memory: "768Mi" } },
              securityContext: restricted(opensteerUid),
              volumeMounts: [
                { name: "data", mountPath: "/data" },
                { name: "host-secret", mountPath: "/run/secrets/host", readOnly: true },
                { name: "host-tmp", mountPath: "/tmp" },
              ],
            },
            {
              name: "gateway",
              image: input.images.gateway,
              env: [
                { name: "OPENSTEER_SITE_ADDRESS", value: `:${gatewayPort}` },
                { name: "OPENSTEER_HOST_UPSTREAM", value: "127.0.0.1:4310" },
              ],
              ports: [{ name: "http", containerPort: gatewayPort }],
              readinessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 5 },
              resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "96Mi" } },
              securityContext: restricted(opensteerUid),
              volumeMounts: [
                { name: "caddy-data", mountPath: "/data" },
                { name: "caddy-config", mountPath: "/config" },
              ],
            },
          ],
          volumes: [
            {
              name: "postgres-secret",
              secret: {
                secretName: teamSecretName,
                defaultMode: 0o440,
                items: [{ key: "postgres-password", path: "postgres-password" }],
              },
            },
            {
              name: "host-secret",
              secret: {
                secretName: teamSecretName,
                defaultMode: 0o440,
                items: [
                  { key: "database-url", path: "database-url" },
                  { key: "auth-secret", path: "auth-secret" },
                  { key: "setup-token-digest", path: "setup-token-digest" },
                ],
              },
            },
            { name: "postgres-run", emptyDir: {} },
            { name: "postgres-tmp", emptyDir: {} },
            { name: "host-tmp", emptyDir: {} },
            { name: "caddy-data", emptyDir: {} },
            { name: "caddy-config", emptyDir: {} },
          ],
        },
      },
      volumeClaimTemplates: [
        {
          metadata: { name: "data", labels },
          spec: {
            accessModes: ["ReadWriteOnce"],
            resources: { requests: { storage: volumeSize } },
          },
        },
      ],
    },
  };
}

/**
 * The team's credentials, generated here once and never read back out of the cluster. Only
 * the setup digest changes later, when Account issues a new setup link.
 */
export function newTeamSecret(input: {
  readonly id: string;
  readonly slug: HostedTeamSlug;
  readonly setupTokenDigest: string;
}): KubernetesObject {
  const password = randomBytes(32).toString("hex");
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
      "postgres-password": password,
      "database-url": `postgresql://opensteer:${password}@127.0.0.1:5432/opensteer`,
      "auth-secret": randomBytes(32).toString("base64url"),
      "setup-token-digest": input.setupTokenDigest,
    },
  };
}
