import { describe, expect, it } from "vitest";
import {
  appliedHashAnnotation,
  edgeNamespace,
  newTeamSecret,
  renderTeam,
  type KubernetesObject,
  type TeamTemplateInput,
} from "./template.js";

const pinned = (name: string, digit: string) =>
  `ghcr.io/steerlabs/${name}@sha256:${digit.repeat(64)}`;
const input: TeamTemplateInput = {
  id: "0b8f2b5e-3c0a-4b8e-9c47-6c1f3a2d9e10",
  slug: "acme",
  name: "Acme Design",
  images: {
    host: pinned("opensteer-team-host", "1"),
  },
  platform: { databaseIp: "10.1.1.1", bucket: "teams", databaseCaDigest: "ca-1" },
  replicas: 1,
  setupGeneration: 1,
};

type Container = {
  readonly name: string;
  readonly args?: readonly string[];
  readonly env: readonly { readonly name: string; readonly value: string }[];
  readonly securityContext: Record<string, unknown>;
};

function find(objects: readonly KubernetesObject[], kind: string) {
  const object = objects.find((candidate) => candidate.kind === kind);
  if (!object) throw new Error(`No ${kind}`);
  return object;
}

function podSpec(objects: readonly KubernetesObject[]) {
  return (
    find(objects, "Deployment").spec as {
      template: {
        spec: {
          automountServiceAccountToken: boolean;
          securityContext: Record<string, unknown>;

          containers: Container[];
        };
      };
    }
  ).template.spec;
}

describe("renderTeam", () => {
  it("lets only the shared edge reach the team, and the team reach only DNS and the internet", () => {
    const objects = renderTeam(input);
    expect(
      objects.every(
        (object) => (object.metadata.namespace ?? object.metadata.name) === "team-acme",
      ),
    ).toBe(true);
    const policy = find(objects, "NetworkPolicy").spec as {
      podSelector: object;
      policyTypes: string[];
      ingress: unknown[];
      egress: { to: { ipBlock?: { cidr: string; except?: string[] } }[]; ports?: unknown[] }[];
    };
    expect(policy.podSelector).toEqual({});
    expect(policy.policyTypes).toEqual(["Ingress", "Egress"]);
    expect(policy.ingress).toEqual([
      {
        from: [
          { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": edgeNamespace } } },
        ],
        ports: [{ protocol: "TCP", port: 4310 }],
      },
    ]);
    const metadataAddress = policy.egress.filter((rule) =>
      rule.to.some((peer) => peer.ipBlock?.cidr.startsWith("169.254.")),
    );
    expect(metadataAddress).toHaveLength(2);
    expect(metadataAddress[0]?.ports).toEqual([
      { protocol: "TCP", port: 80 },
      { protocol: "TCP", port: 8080 },
    ]);
    const internet = policy.egress.find((rule) =>
      rule.to.some((peer) => peer.ipBlock?.cidr === "0.0.0.0/0"),
    );
    expect(internet?.ports).toBeUndefined();
    expect(internet?.to[0]?.ipBlock?.except).toEqual(
      expect.arrayContaining(["10.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.168.0.0/16"]),
    );
    const namespace = find(objects, "Namespace");
    expect(namespace.metadata.labels?.["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  });

  it("runs every container unprivileged, with no API credentials and Postgres on loopback", () => {
    const objects = renderTeam(input);
    expect(JSON.stringify(objects)).not.toMatch(
      /PersistentVolumeClaim|volumeClaimTemplates|StatefulSet/,
    );
    expect(find(objects, "Deployment").spec).toMatchObject({
      replicas: 1,
      minReadySeconds: 10,
      strategy: { type: "RollingUpdate", rollingUpdate: { maxSurge: 1, maxUnavailable: 0 } },
    });
    const spec = podSpec(objects);
    expect(spec).toMatchObject({
      serviceAccountName: "team",
      terminationGracePeriodSeconds: 90,
      containers: [
        {
          name: "host",
          readinessProbe: { httpGet: { path: "/readyz" } },
          livenessProbe: { httpGet: { path: "/healthz" } },
        },
      ],
    });
    expect(spec.automountServiceAccountToken).toBe(false);
    expect(spec.securityContext).toMatchObject({
      runAsNonRoot: true,
      seccompProfile: { type: "RuntimeDefault" },
    });
    for (const container of spec.containers) {
      expect(container.securityContext, container.name).toMatchObject({
        runAsNonRoot: true,
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        capabilities: { drop: ["ALL"] },
      });
    }
    const env = (name: string) =>
      Object.fromEntries(
        spec.containers
          .find((container) => container.name === name)!
          .env.map((entry) => [entry.name, entry.value]),
      );
    expect(env("host")).toMatchObject({
      OPENSTEER_DEPLOYMENT_KIND: "team",
      OPENSTEER_DEPLOYMENT_NAME: "Acme Design",
      OPENSTEER_CANONICAL_ORIGIN: "https://acme.teams.opensteer.com",
      OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST_FILE: "/run/secrets/host/setup-token-digest",
    });
  });

  it("changes its digest exactly when what runs changes", () => {
    const hash = (overrides: Partial<TeamTemplateInput>) =>
      find(renderTeam({ ...input, ...overrides }), "Deployment").metadata.annotations?.[
        appliedHashAnnotation
      ];
    expect(hash({})).toBe(hash({}));
    expect(hash({ setupGeneration: 2 })).not.toBe(hash({}));
    expect(hash({ replicas: 0 })).not.toBe(hash({}));
    expect(
      hash({ images: { ...input.images, host: pinned("opensteer-team-host", "9") } }),
    ).not.toBe(hash({}));
  });

  it("generates fresh credentials for each team and keeps them out of the pod template", () => {
    const first = newTeamSecret({
      id: input.id,
      slug: "acme",
      setupTokenDigest: "a".repeat(64),
      databaseUrl: "postgresql://test",
      databaseCa: "CA",
    });
    const second = newTeamSecret({
      id: input.id,
      slug: "acme",
      setupTokenDigest: "a".repeat(64),
      databaseUrl: "postgresql://test",
      databaseCa: "CA",
    });
    const data = (secret: KubernetesObject) => secret.stringData as Record<string, string>;
    expect(data(first)["host-private.pem"]).not.toBe(data(second)["host-private.pem"]);
    expect(data(first)["auth-secret"]).not.toBe(data(second)["auth-secret"]);
    expect(JSON.stringify(renderTeam(input))).not.toContain("a".repeat(64));
  });
});
