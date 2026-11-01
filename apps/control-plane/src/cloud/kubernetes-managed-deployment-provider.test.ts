import { hostEnvironmentKeys } from "@opensteer/config";
import { createId } from "@opensteer/core";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GoogleMetadataAccessTokenProvider,
  KubernetesManagedDeploymentProvider,
  deploymentPodsAbsent,
  managedWorkloadStatus,
  type KubernetesManagedDeploymentClient,
  type ManagedWorkloadStatus,
} from "./kubernetes-managed-deployment-provider.js";
import type { KubernetesObject } from "./kubernetes-managed-deployment-resources.js";

const portableFsFixture = Buffer.from("managed PortableFS mount binary");
const template = {
  browserEgressImage: `registry.test/browser-egress@sha256:${"1".repeat(64)}`,
  browserRuntimeImage: `registry.test/browser-runtime@sha256:${"2".repeat(64)}`,
  channelRuntimeImage: `registry.test/channel-runtime@sha256:${"3".repeat(64)}`,
  filesImage: `registry.test/files@sha256:${"4".repeat(64)}`,
  fuseResourceName: "opensteer.com/fuse",
  hostImage: `registry.test/host@sha256:${"5".repeat(64)}`,
  ingressSourceCidrs: ["35.191.0.0/16"],
  kubernetesApiServer: "https://10.0.0.2",
  kubernetesCa: "-----BEGIN CERTIFICATE-----\ndGVzdA==\n-----END CERTIFICATE-----\n",
  namespacePrefix: "opensteer",
  portableFsMountImage: `registry.test/portablefs@sha256:${"6".repeat(64)}`,
  portableFsMountSha256: `sha256:${createHash("sha256").update(portableFsFixture).digest("hex")}`,
  portableFsManagerUrl: "https://portablefs.test",
  portableFsManagerCidrs: ["10.20.0.0/16"],
  portableFsManagerCa: "ca",
  portableFsManagerCertificate: "certificate",
  portableFsManagerPrivateKey: "client-key",
  portableFsProductPrivateKey: "product-key",
  portableFsProductIssuer: "opensteer-managed",
  portableFsServiceId: "opensteer",
  postgresImage: `postgres:18-alpine@sha256:${"7".repeat(64)}`,
  runnerImage: `registry.test/runner@sha256:${"8".repeat(64)}`,
  storageClassName: "standard-rwo",
  version: 1 as const,
};
const managedSecrets = {
  "account-bundle.json": "{}",
  "credential.key": "c".repeat(32),
  "host-private.pem": "private",
  "host-public.pem": "public",
  OPENSTEER_AUTH_SECRET: "a".repeat(32),
  OPENSTEER_BROWSER_BRIDGE_TOKEN: "g".repeat(32),
  OPENSTEER_BROWSER_RUNNER_ENROLLMENT_TOKEN: "w".repeat(32),
  OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN: "h".repeat(32),
  OPENSTEER_RUNNER_ENROLLMENT_TOKEN: "r".repeat(32),
  POSTGRES_PASSWORD: "p".repeat(32),
  "hosting-template.json": JSON.stringify(template),
};

describe("KubernetesManagedDeploymentProvider", () => {
  it("applies the fixed topology idempotently and gates ready on every workload", async () => {
    const applied: KubernetesObject[] = [];
    const readiness = new Map<string, boolean>();
    const client = clientFixture(applied, readiness);
    const selectedServers: string[] = [];
    const provider = new KubernetesManagedDeploymentProvider({
      clientForTemplate: (operationTemplate) => {
        selectedServers.push(operationTemplate.kubernetesApiServer);
        return client;
      },
      template: {
        ...template,
        kubernetesApiServer: "https://10.0.0.9",
        namespacePrefix: "replacement",
      },
    });
    const deploymentId = createId("deployment");
    const input = {
      canonicalOrigin: "https://example.managed.test",
      deploymentId,
      name: "Example",
      operationId: "operation-1",
      secrets: managedSecrets,
    };

    await expect(provider.ensure(input)).resolves.toEqual({
      ready: false,
      waiting: [
        "postgres",
        "host",
        "runner",
        "browser-egress",
        "browser-runtime",
        "channel-runtime",
      ],
    });
    expect(selectedServers).toEqual(["https://10.0.0.2"]);
    expect(applied.map(({ kind, metadata }) => `${kind}/${metadata.name}`)).toEqual(
      expect.arrayContaining([
        "Namespace/opensteer-" + deploymentId.slice(4).replaceAll("-", ""),
        "Secret/runtime",
        "Deployment/host",
        "Deployment/runner",
        "Deployment/browser-runtime",
        "Deployment/channel-runtime",
      ]),
    );
    const secrets = applied.filter(({ kind }) => kind === "Secret");
    expect(
      secrets.map(({ metadata, stringData }) => [
        metadata.name,
        Object.keys(stringData ?? {}).sort(),
      ]),
    ).toEqual(
      expect.arrayContaining([
        ["runner-enrollment", ["OPENSTEER_RUNNER_ENROLLMENT_TOKEN"]],
        // Each module-only computer gets its own one-use enrollment.
        [
          "browser-enrollment",
          ["OPENSTEER_BROWSER_BRIDGE_TOKEN", "OPENSTEER_RUNNER_ENROLLMENT_TOKEN"],
        ],
        ["messaging-enrollment", ["OPENSTEER_RUNNER_ENROLLMENT_TOKEN"]],
        ["postgres-password", ["POSTGRES_PASSWORD"]],
        ["browser-trust", ["host-public.pem"]],
      ]),
    );
    expect(applied.filter(({ kind }) => kind === "NetworkPolicy")).toHaveLength(2);
    expect(
      applied.find(
        ({ kind, metadata }) =>
          kind === "NetworkPolicy" && metadata.name === "host-portablefs-egress",
      ),
    ).toMatchObject({
      spec: {
        egress: [{ to: [{ ipBlock: { cidr: "10.20.0.0/16" } }] }],
        podSelector: {
          matchExpressions: [
            {
              key: "app.kubernetes.io/name",
              operator: "In",
              values: ["host", "runner", "managed-teardown"],
            },
          ],
        },
      },
    });
    const host = applied.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name === "host",
    );
    expect(host).toMatchObject({
      spec: {
        template: {
          spec: {
            initContainers: [
              expect.objectContaining({
                name: "initialize-host-volumes",
                securityContext: expect.objectContaining({
                  capabilities: { add: ["CHOWN", "FOWNER"], drop: ["ALL"] },
                }),
              }),
              expect.objectContaining({ name: "stage-host-secrets" }),
            ],
            securityContext: { seccompProfile: { type: "RuntimeDefault" } },
          },
        },
      },
    });
    expect(JSON.stringify(host)).not.toContain("fsGroup");
    expect(host).toMatchObject({
      spec: {
        template: {
          spec: {
            containers: expect.arrayContaining([
              expect.objectContaining({
                name: "host",
                volumeMounts: expect.arrayContaining([
                  { mountPath: "/run/opensteer", name: "runtime" },
                ]),
              }),
              expect.objectContaining({
                name: "files",
                volumeMounts: expect.arrayContaining([
                  { mountPath: "/run/opensteer", name: "files-trust", readOnly: true },
                ]),
              }),
            ]),
            initContainers: expect.arrayContaining([
              expect.objectContaining({
                name: "initialize-host-volumes",
                args: [
                  expect.stringContaining(
                    "cp /staged-trust/host-public.pem /files-trust/host-public.pem",
                  ),
                ],
              }),
            ]),
          },
        },
      },
    });
    expect(host).toMatchObject({
      spec: {
        template: {
          spec: {
            volumes: expect.arrayContaining([
              { name: "staged-runtime", secret: { defaultMode: 292, secretName: "runtime" } },
              { name: "files-trust", emptyDir: {} },
            ]),
          },
        },
      },
    });
    expect(
      applied.find(
        ({ kind, metadata }) => kind === "NetworkPolicy" && metadata.name === "tenant-isolation",
      ),
    ).toEqual(
      expect.objectContaining({
        spec: expect.objectContaining({
          ingress: expect.arrayContaining([
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
          ]),
        }),
      }),
    );
    expect(
      JSON.stringify(applied.find(({ metadata }) => metadata.name === "runner")),
    ).not.toContain("host-private.pem");
    const runnerDeployment = applied.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name === "runner",
    );
    const runner = JSON.stringify(runnerDeployment);
    expect(runner).not.toContain('"privileged":true');
    expect(runner).not.toContain("hostPath");
    expect(runner).toContain('"opensteer.com/fuse":"1"');
    expect(runner).toContain(
      `"name":"OPENSTEER_PORTABLEFS_MOUNT_SHA256","value":"${template.portableFsMountSha256.slice("sha256:".length)}"`,
    );
    const backingEnvironmentName = hostEnvironmentKeys.defaultWorkspaceBacking;
    expect(JSON.stringify(host)).toContain(`"name":"${backingEnvironmentName}"`);
    expect(runner).toContain(`"name":"${backingEnvironmentName}"`);
    expect(JSON.stringify(applied)).not.toContain("OPENSTEER_WORKSPACE_BACKING");
    expect(runnerDeployment).toMatchObject({
      spec: {
        template: {
          spec: {
            containers: [
              expect.objectContaining({
                env: expect.arrayContaining([
                  {
                    name: "OPENSTEER_PORTABLEFS_MOUNT_BINARY",
                    value: "/opt/portablefs/portablefs",
                  },
                  {
                    name: "OPENSTEER_PORTABLEFS_MOUNT_SHA256",
                    value: template.portableFsMountSha256.slice("sha256:".length),
                  },
                ]),
                name: "runner",
                securityContext: expect.objectContaining({
                  capabilities: { add: ["DAC_READ_SEARCH", "SYS_ADMIN"], drop: ["ALL"] },
                  seccompProfile: {
                    localhostProfile: "opensteer/runner.json",
                    type: "Localhost",
                  },
                }),
              }),
            ],
          },
        },
      },
    });
    const runnerPodSpec = runnerDeployment?.spec as {
      readonly template: {
        readonly spec: {
          readonly containers: readonly {
            readonly env: readonly { readonly name: string; readonly value?: string }[];
            readonly name: string;
          }[];
        };
      };
    };
    const runnerEnvironment = Object.fromEntries(
      runnerPodSpec.template.spec.containers
        .find(({ name }) => name === "runner")
        ?.env.flatMap(({ name, value }) => (value === undefined ? [] : [[name, value]])) ?? [],
    );
    const { verifyPortableFsArtifact } = await vi.importActual<{
      verifyPortableFsArtifact(target: NodeJS.ProcessEnv): Promise<void>;
    }>("../../../../deploy/container/opensteer-entrypoint.mjs");
    const portableFsDirectory = await mkdtemp(join(tmpdir(), "opensteer-managed-portablefs-"));
    const portableFsBinary = join(portableFsDirectory, "portablefs");
    runnerEnvironment.OPENSTEER_PORTABLEFS_MOUNT_BINARY = portableFsBinary;
    try {
      await writeFile(portableFsBinary, portableFsFixture);
      await expect(verifyPortableFsArtifact(runnerEnvironment)).resolves.toBeUndefined();
      await writeFile(portableFsBinary, "different artifact");
      await expect(verifyPortableFsArtifact(runnerEnvironment)).rejects.toThrow(
        "does not match OPENSTEER_PORTABLEFS_MOUNT_SHA256",
      );
    } finally {
      await rm(portableFsDirectory, { force: true, recursive: true });
    }
    for (const name of ["runner", "browser-runtime", "channel-runtime"]) {
      const runtime = applied.find(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name === name,
      );
      expect(JSON.stringify(runtime)).not.toContain("fsGroup");
      expect(runtime).toMatchObject({
        spec: {
          template: {
            spec: {
              initContainers: [
                expect.objectContaining({
                  name: "initialize-runtime-volumes",
                  securityContext: expect.objectContaining({
                    capabilities: { add: ["CHOWN", "FOWNER"], drop: ["ALL"] },
                  }),
                }),
                ...(name === "runner"
                  ? [expect.objectContaining({ name: "install-portablefs" })]
                  : []),
              ],
              securityContext: { seccompProfile: { type: "RuntimeDefault" } },
            },
          },
        },
      });
    }
    expect(
      applied.find(({ kind, metadata }) => kind === "Deployment" && metadata.name === "postgres"),
    ).toMatchObject({
      spec: { template: { spec: { securityContext: { fsGroup: 999 } } } },
    });
    expect(
      applied.find(
        ({ kind, metadata }) => kind === "Deployment" && metadata.name === "browser-runtime",
      ),
    ).toMatchObject({
      spec: {
        template: {
          spec: {
            containers: [
              expect.objectContaining({
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
                volumeMounts: expect.arrayContaining([
                  { mountPath: "/dev/shm", name: "shm" },
                  { mountPath: "/home/opensteer", name: "home" },
                ]),
              }),
            ],
            volumes: expect.arrayContaining([
              { emptyDir: { medium: "Memory", sizeLimit: "256Mi" }, name: "home" },
              { emptyDir: { medium: "Memory", sizeLimit: "1Gi" }, name: "shm" },
            ]),
          },
        },
      },
    });
    for (const resource of applied.filter(({ kind }) => kind === "Deployment")) {
      expect(resource).toMatchObject({
        spec: {
          // Kubernetes, not a wall clock in the control plane, judges a stuck rollout.
          progressDeadlineSeconds: 600,
          template: { spec: { automountServiceAccountToken: false } },
        },
      });
    }
    for (const name of [
      "postgres",
      "host",
      "runner",
      "browser-egress",
      "browser-runtime",
      "channel-runtime",
    ])
      readiness.set(name, true);
    const firstCount = applied.length;
    await expect(provider.ensure(input)).resolves.toEqual({ ready: true });
    expect(applied).toHaveLength(firstCount * 2);
  });

  it("deletes legacy deployments without credentials for newer browser and messaging computers", async () => {
    const applied: KubernetesObject[] = [];
    const client = clientFixture(applied, new Map([["postgres", true]]));
    client.jobStatus = async () => "absent";
    const provider = new KubernetesManagedDeploymentProvider({ client, template });
    const secrets = Object.fromEntries(
      Object.entries(managedSecrets).filter(([key]) => !key.endsWith("_TOKEN")),
    );
    const input = {
      canonicalOrigin: "https://example.managed.test",
      deploymentId: createId("deployment"),
      name: "Legacy deployment",
      operationId: "legacy-deletion",
      secrets,
    };
    await expect(provider.delete(input)).resolves.toBe(false);
    expect(applied.some(({ kind }) => kind === "Job")).toBe(true);
    expect(JSON.stringify(applied)).not.toContain("ENROLLMENT_TOKEN");
    expect(applied.find(({ metadata }) => metadata.name === "runtime")?.stringData).toMatchObject({
      "account-bundle.json": secrets["account-bundle.json"],
      "portablefs-client-key.pem": template.portableFsManagerPrivateKey,
    });
    await expect(provider.ensure(input)).rejects.toThrow();
    await expect(
      provider.delete({ ...input, secrets: { ...secrets, POSTGRES_PASSWORD: "" } }),
    ).rejects.toThrow();
  });

  it("starts teardown with the current release against the captured placement", async () => {
    const applied: KubernetesObject[] = [];
    const client = clientFixture(applied, new Map([["postgres", true]]));
    client.jobStatus = async () => "absent";
    const currentHostImage = `registry.test/host@sha256:${"9".repeat(64)}`;
    const provider = new KubernetesManagedDeploymentProvider({
      client,
      template: {
        ...template,
        hostImage: currentHostImage,
        namespacePrefix: "replacement",
        portableFsManagerUrl: "https://replacement-portablefs.test",
      },
    });
    const deploymentId = createId("deployment");

    await expect(
      provider.delete({
        canonicalOrigin: "https://example.managed.test",
        deploymentId,
        name: "Example",
        operationId: "operation-2",
        secrets: managedSecrets,
      }),
    ).resolves.toBe(false);
    const teardownJob = applied.find(
      ({ kind, metadata }) => kind === "Job" && metadata.name === "managed-teardown",
    );
    expect(teardownJob).toMatchObject({
      kind: "Job",
      metadata: {
        name: "managed-teardown",
        namespace: "opensteer-" + deploymentId.slice(4).replaceAll("-", ""),
      },
      spec: {
        template: {
          spec: {
            automountServiceAccountToken: false,
            initContainers: [
              expect.objectContaining({
                image: template.portableFsMountImage,
                name: "initialize-runtime-volume",
              }),
              expect.objectContaining({ image: currentHostImage, name: "stage-host-secrets" }),
            ],
            containers: [
              expect.objectContaining({
                env: expect.arrayContaining([
                  {
                    // The PortableFS manager endpoint and its credentials rotate with the
                    // platform, so teardown reaches the one that is answering today.
                    name: "OPENSTEER_PORTABLEFS_MANAGER_URL",
                    value: "https://replacement-portablefs.test",
                  },
                ]),
                image: currentHostImage,
                name: "teardown",
              }),
            ],
            securityContext: { seccompProfile: { type: "RuntimeDefault" } },
            volumes: expect.arrayContaining([
              { name: "staged-runtime", secret: { defaultMode: 292, secretName: "runtime" } },
            ]),
          },
        },
      },
    });
    expect(JSON.stringify(teardownJob)).not.toContain("fsGroup");
    expect(JSON.stringify(teardownJob)).not.toContain("OPENSTEER_RUNNER_ENROLLMENT_TOKEN");
    expect(client.deleteNamespace).not.toHaveBeenCalled();
  });

  it.each([
    ["pending", false, false],
    ["failed", true, false],
    ["complete", false, true],
  ] as const)(
    "does not replace an existing %s teardown Job",
    async (jobStatus, deletesJob, deletesNamespace) => {
      const applied: KubernetesObject[] = [];
      const client = clientFixture(applied, new Map([["postgres", true]]));
      client.jobStatus = async () => jobStatus;
      const provider = new KubernetesManagedDeploymentProvider({
        client,
        template: { ...template, hostImage: `registry.test/host@sha256:${"9".repeat(64)}` },
      });

      await expect(
        provider.delete({
          canonicalOrigin: "https://example.managed.test",
          deploymentId: createId("deployment"),
          name: "Example",
          operationId: "operation-existing-job",
          secrets: managedSecrets,
        }),
      ).resolves.toBe(false);

      expect(applied.filter(({ kind }) => kind === "Job")).toEqual([]);
      expect(client.deleteJob).toHaveBeenCalledTimes(deletesJob ? 1 : 0);
      expect(client.deleteNamespace).toHaveBeenCalledTimes(deletesNamespace ? 1 : 0);
    },
  );

  it("rejects unpinned workload images", () => {
    expect(
      () =>
        new KubernetesManagedDeploymentProvider({
          client: clientFixture([], new Map()),
          template: { ...template, runnerImage: "registry.test/runner:latest" },
        }),
    ).toThrow("Image must be pinned");
  });

  it("deletes an interrupted pre-Host namespace without starting teardown workloads", async () => {
    const applied: KubernetesObject[] = [];
    const client = clientFixture(applied, new Map());
    client.resourceExists = async () => false;
    const provider = new KubernetesManagedDeploymentProvider({ client, template });
    const deploymentId = createId("deployment");

    await provider.delete({
      canonicalOrigin: "https://example.managed.test",
      deploymentId,
      name: "Example",
      operationId: "operation-partial",
      secrets: managedSecrets,
    });

    expect(applied).toEqual([]);
    expect(client.scaleDeployment).not.toHaveBeenCalled();
    expect(client.deleteNamespace).toHaveBeenCalledOnce();
  });

  it("only waits when namespace deletion is already in progress", async () => {
    const client = clientFixture([], new Map());
    client.namespaceState = async () => "terminating";
    const provider = new KubernetesManagedDeploymentProvider({ client, template });

    await expect(
      provider.delete({
        canonicalOrigin: "https://example.managed.test",
        deploymentId: createId("deployment"),
        name: "Example",
        operationId: "operation-terminating",
        secrets: managedSecrets,
      }),
    ).resolves.toBe(false);
    expect(client.scaleDeployment).not.toHaveBeenCalled();
    expect(client.deleteNamespace).not.toHaveBeenCalled();
  });
});

describe("GoogleMetadataAccessTokenProvider", () => {
  it("requests and caches a bounded Workload Identity access token", async () => {
    const fetchImplementation = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "short-lived-token",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const provider = new GoogleMetadataAccessTokenProvider(fetchImplementation);

    await expect(provider.accessToken()).resolves.toBe("short-lived-token");
    await expect(provider.accessToken()).resolves.toBe("short-lived-token");
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(fetchImplementation).toHaveBeenCalledWith(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" }, redirect: "error" },
    );
  });

  it("rejects invalid metadata token responses without reflecting their body", async () => {
    const provider = new GoogleMetadataAccessTokenProvider(
      async () => new Response("credential-material", { status: 403 }),
    );
    const error = await provider.accessToken().catch((reason: unknown) => reason);
    expect(String(error)).toContain("HTTP 403");
    expect(String(error)).not.toContain("credential-material");
  });
});

describe("managed release convergence", () => {
  const placementKeys = [
    "fuseResourceName",
    "kubernetesApiServer",
    "kubernetesCa",
    "namespacePrefix",
    "portableFsProductIssuer",
    "portableFsServiceId",
    "postgresImage",
    "storageClassName",
    "version",
  ];

  it("captures only what must never move and identifies the live release", () => {
    const provider = new KubernetesManagedDeploymentProvider({
      client: clientFixture([], new Map()),
      template,
    });
    const captured = JSON.parse(provider.captureConfiguration()) as Record<string, unknown>;
    expect(Object.keys(captured).sort()).toEqual([...placementKeys].sort());
    // Nothing that names a build is durable; nothing that rotates is durable either.
    expect(JSON.stringify(captured)).not.toContain(template.hostImage);
    expect(JSON.stringify(captured)).not.toContain(template.portableFsManagerPrivateKey);

    const release = provider.currentRelease();
    expect(release).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(
      new KubernetesManagedDeploymentProvider({
        client: clientFixture([], new Map()),
        template: { ...template, namespacePrefix: "elsewhere" },
      }).currentRelease(),
    ).toBe(release);
    expect(
      new KubernetesManagedDeploymentProvider({
        client: clientFixture([], new Map()),
        template: {
          ...template,
          channelRuntimeImage: `registry.test/channel@sha256:${"a".repeat(64)}`,
        },
      }).currentRelease(),
    ).not.toBe(release);
  });

  it("applies the live images over a full-template snapshot written before the split", async () => {
    const applied: KubernetesObject[] = [];
    const currentChannelImage = `registry.test/channel-runtime@sha256:${"b".repeat(64)}`;
    const provider = new KubernetesManagedDeploymentProvider({
      client: clientFixture(applied, new Map()),
      template: {
        ...template,
        channelRuntimeImage: currentChannelImage,
        // A placement field in the live template never redirects an existing operation.
        namespacePrefix: "replacement",
        storageClassName: "premium-rwo",
      },
    });
    const deploymentId = createId("deployment");

    // managedSecrets still carries the whole template, exactly as existing rows do.
    await provider.ensure({
      canonicalOrigin: "https://example.managed.test",
      deploymentId,
      name: "Example",
      operationId: "operation-3",
      secrets: managedSecrets,
    });
    const channel = applied.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name === "channel-runtime",
    );
    expect(JSON.stringify(channel)).toContain(currentChannelImage);
    expect(applied[0]?.metadata.name).toBe(
      "opensteer-" + deploymentId.slice(4).replaceAll("-", ""),
    );
    expect(applied.find(({ kind }) => kind === "PersistentVolumeClaim")).toMatchObject({
      spec: { storageClassName: template.storageClassName },
    });
  });

  it("gives the messaging service the runtime's own contract and a durable identity", async () => {
    const applied: KubernetesObject[] = [];
    const provider = new KubernetesManagedDeploymentProvider({
      client: clientFixture(applied, new Map()),
      template,
    });
    const canonicalOrigin = "https://example.managed.test";

    await provider.ensure({
      canonicalOrigin,
      deploymentId: createId("deployment"),
      name: "Example",
      operationId: "operation-4",
      secrets: managedSecrets,
    });
    const channel = applied.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name === "channel-runtime",
    );
    const channelSpec = channel?.spec as {
      readonly template: {
        readonly spec: {
          readonly containers: readonly {
            readonly env: readonly {
              readonly name: string;
              readonly value?: string;
              readonly valueFrom?: {
                readonly secretKeyRef: { readonly key: string; readonly name: string };
              };
            }[];
            readonly volumeMounts: readonly { readonly mountPath: string; readonly name: string }[];
          }[];
          readonly volumes: readonly {
            readonly name: string;
            readonly persistentVolumeClaim?: { readonly claimName: string };
          }[];
        };
      };
    };
    const container = channelSpec.template.spec.containers[0]!;
    const environment = Object.fromEntries(
      container.env.flatMap(({ name, value }) => (value === undefined ? [] : [[name, value]])),
    );
    // The messaging service parses its own environment; nothing here may drift
    // from the names and the production transport rule that file enforces.
    const { parseChannelRuntimeConfig } = await vi.importActual<{
      parseChannelRuntimeConfig(target: NodeJS.ProcessEnv): {
        readonly bindAddress: string;
        readonly dataDirectory: string;
        readonly hostUrl: URL;
        readonly mode: string;
        readonly port: number;
      };
    }>("../../../channel-runtime/src/config.js");
    const config = parseChannelRuntimeConfig({
      ...environment,
      OPENSTEER_RUNNER_ENROLLMENT_TOKEN: managedSecrets.OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN,
    });
    expect(config).toMatchObject({
      bindAddress: "0.0.0.0",
      hostUrl: new URL(canonicalOrigin),
      mode: "production",
      port: 4320,
    });
    // The one-use token is consumed on first enrollment, so the identity the
    // service writes must outlive its pod or messaging dies on a restart.
    const identityVolume = container.volumeMounts.find(
      ({ mountPath }) => mountPath === config.dataDirectory,
    );
    expect(
      channelSpec.template.spec.volumes.find(({ name }) => name === identityVolume?.name),
    ).toEqual({ name: "data", persistentVolumeClaim: { claimName: "channel-data" } });
    expect(
      applied.find(
        ({ kind, metadata }) =>
          kind === "PersistentVolumeClaim" && metadata.name === "channel-data",
      ),
    ).toBeDefined();
    expect(container.env.find(({ name }) => name === "OPENSTEER_RUNNER_ENROLLMENT_TOKEN")).toEqual({
      name: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
      valueFrom: {
        secretKeyRef: {
          key: "OPENSTEER_RUNNER_ENROLLMENT_TOKEN",
          name: "messaging-enrollment",
        },
      },
    });
    // The Host pre-registers that same token under a fixed idempotency key, so
    // the two secrets are one value or the enrollment is refused.
    const hostDeployment = applied.find(
      ({ kind, metadata }) => kind === "Deployment" && metadata.name === "host",
    );
    expect(hostDeployment).toBeDefined();
    const hostEnvironment = (
      hostDeployment!.spec as {
        readonly template: {
          readonly spec: {
            readonly containers: readonly {
              readonly env: readonly {
                readonly name: string;
                readonly valueFrom?: {
                  readonly secretKeyRef: { readonly key: string; readonly name: string };
                };
              }[];
              readonly name: string;
            }[];
          };
        };
      }
    ).template.spec.containers.find(({ name }) => name === "host")?.env;
    expect(
      hostEnvironment?.find(
        ({ name }) => name === "OPENSTEER_INITIAL_MESSAGING_RUNNER_ENROLLMENT_TOKEN",
      )?.valueFrom,
    ).toEqual({
      secretKeyRef: { key: "OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN", name: "runtime" },
    });
    const messagingSecret = applied.find(
      ({ kind, metadata }) => kind === "Secret" && metadata.name === "messaging-enrollment",
    );
    const runtimeSecret = applied.find(
      ({ kind, metadata }) => kind === "Secret" && metadata.name === "runtime",
    );
    expect(messagingSecret?.stringData?.OPENSTEER_RUNNER_ENROLLMENT_TOKEN).toBe(
      runtimeSecret?.stringData?.OPENSTEER_MESSAGING_RUNNER_ENROLLMENT_TOKEN,
    );
  });
});

describe("managedWorkloadStatus", () => {
  it("reads readiness and Kubernetes' own terminal rollout verdict", () => {
    expect(
      managedWorkloadStatus({
        metadata: { generation: 3 },
        status: { observedGeneration: 3, availableReplicas: 1, updatedReplicas: 1 },
      }),
    ).toEqual({ state: "ready" });
    expect(
      managedWorkloadStatus({
        metadata: { generation: 3 },
        status: { observedGeneration: 2, availableReplicas: 1, updatedReplicas: 1 },
      }),
    ).toEqual({ state: "progressing" });
    expect(
      managedWorkloadStatus({
        metadata: { generation: 1 },
        status: {
          observedGeneration: 1,
          conditions: [
            { type: "Available", status: "False", reason: "MinimumReplicasUnavailable" },
            { type: "Progressing", status: "True", reason: "ReplicaSetUpdated" },
          ],
        },
      }),
    ).toEqual({ state: "progressing" });
    expect(
      managedWorkloadStatus({
        metadata: { generation: 1 },
        status: {
          observedGeneration: 1,
          conditions: [
            { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" },
          ],
        },
      }),
    ).toEqual({ reason: "ProgressDeadlineExceeded", state: "failed" });
    expect(managedWorkloadStatus({})).toEqual({ state: "progressing" });
  });

  it("does not judge a new rollout by the verdict on the one it replaced", () => {
    // Just after a Retry applies new images: the last rollout timed out, and
    // Kubernetes has not yet observed the new generation.
    expect(
      managedWorkloadStatus({
        metadata: { generation: 4 },
        status: {
          observedGeneration: 3,
          availableReplicas: 0,
          updatedReplicas: 0,
          conditions: [
            { type: "Progressing", status: "False", reason: "ProgressDeadlineExceeded" },
          ],
        },
      }),
    ).toEqual({ state: "progressing" });
  });
});

describe("deploymentPodsAbsent", () => {
  it("requires an exact empty Pod list and retains terminating Pods", () => {
    expect(deploymentPodsAbsent({ items: [] })).toBe(true);
    expect(
      deploymentPodsAbsent({
        items: [{ metadata: { deletionTimestamp: "2026-09-05T00:00:00Z", name: "host-old" } }],
      }),
    ).toBe(false);
    expect(deploymentPodsAbsent({})).toBe(false);
  });
});

function clientFixture(
  applied: KubernetesObject[],
  readiness: ReadonlyMap<string, ManagedWorkloadStatus | boolean>,
): KubernetesManagedDeploymentClient {
  return {
    namespaceState: async () => "active",
    apply: async (resource) => {
      applied.push(resource);
    },
    deleteJob: vi.fn(async () => undefined),
    deleteNamespace: vi.fn(async () => false),
    deploymentScaledDown: async () => true,
    jobStatus: async () => "complete",
    resourceExists: async () => true,
    scaleDeployment: vi.fn(async () => undefined),
    validateConfiguration: async () => undefined,
    workloadStatus: async (_namespace, name) => {
      const status = readiness.get(name);
      if (typeof status === "object") return status;
      return status ? { state: "ready" } : { state: "progressing" };
    },
  };
}
