import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createId } from "@opensteer/core";
import type { PortableFsWorkspaceExecutionAccessPlan } from "@opensteer/workspace";
import type {
  PortableFsMountInput,
  PortableFsMountList,
  PortableFsMountStatus,
  PortableFsRunner,
} from "@opensteer/workspace-portablefs";
import { PortableFsVolumeIdSchema } from "@opensteer/workspace-portablefs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceMountRegistry, type MountIdentityIssuer } from "./workspace-mount-registry.js";

const certificate = "-----BEGIN CERTIFICATE-----\ntest\n-----END CERTIFICATE-----\n";
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("WorkspaceMountRegistry", () => {
  it("bounds a mount grant exchange whose fetch never settles", async () => {
    vi.useFakeTimers();
    const fixture = await registryFixture();
    const fetch = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const registry = fixture.createRegistry(fetch);
    const operation = registry.ensureMounted(mountPlan(), new AbortController().signal);
    await vi.waitUntil(() => fetch.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(operation).rejects.toThrow("Mount grant exchange could not be reached");
  });

  it("keeps the exchange request alive until a streamed response body is consumed", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const bytes = new TextEncoder().encode(JSON.stringify(exchangeResponse(plan.volumeId)));
      return new Response(
        new ReadableStream({
          start(controller) {
            const timer = setTimeout(() => {
              controller.enqueue(bytes);
              controller.close();
            }, 10);
            init?.signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                controller.error(new Error("request aborted before body completion"));
              },
              { once: true },
            );
          },
        }),
      );
    });

    await expect(
      fixture.createRegistry(fetch).ensureMounted(plan, new AbortController().signal),
    ).resolves.toEqual({ path: resolve(fixture.root, plan.workspaceId) });
  });

  it("bounds a mount grant response body that never finishes", async () => {
    vi.useFakeTimers();
    const fixture = await registryFixture();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener(
                "abort",
                () => controller.error(new Error("request aborted during body")),
                { once: true },
              );
            },
          }),
        ),
      ),
    );
    const operation = fixture
      .createRegistry(fetch)
      .ensureMounted(mountPlan(), new AbortController().signal);
    await vi.waitUntil(() => fetch.mock.calls.length === 1);

    await vi.advanceTimersByTimeAsync(30_000);

    await expect(operation).rejects.toThrow("Mount grant exchange could not be reached");
  });

  it("fails an oversized exchange response without retrying it", async () => {
    const fixture = await registryFixture();
    const fetch = vi.fn(async () => new Response("x".repeat(128 * 1_024 + 1)));

    await expect(
      fixture.createRegistry(fetch).ensureMounted(mountPlan(), new AbortController().signal),
    ).rejects.toThrow("Mount grant exchange response exceeded the size limit");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("requires the v2 automatic reauthorization feature", async () => {
    const fixture = await registryFixture();
    fixture.portableFs.features = ["hosted-automatic-mount-reauthorization-v1"];
    await expect(fixture.registry.preflight()).rejects.toThrow(
      "hosted-automatic-mount-reauthorization-v2",
    );
  });

  it("serializes concurrent demand for one Workspace into one machine mount", async () => {
    const fixture = await registryFixture();
    await fixture.registry.preflight();
    const plan = mountPlan();
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      fixture.registry.ensureMounted(plan, signal),
      fixture.registry.ensureMounted(plan, signal),
    ]);

    expect(first.path).toBe(resolve(fixture.root, plan.workspaceId));
    expect(second).toEqual(first);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(fixture.portableFs.mountCalls).toHaveLength(1);
    expect(fixture.registry.inventory()).toEqual([
      {
        enrollmentId: "enrollment-1",
        volumeId: plan.volumeId,
        workspaceId: plan.workspaceId,
      },
    ]);
  });

  it("derives owner-scoped Main and specialized canonical paths", async () => {
    const fixture = await registryFixture("owner-scoped");
    const userId = createId("user");
    const main = mountPlan({ createdBy: userId, workspaceKind: "main" });
    const specialized = mountPlan({ createdBy: userId });

    expect((await fixture.registry.ensureMounted(main, new AbortController().signal)).path).toBe(
      resolve(fixture.root, userId, "main"),
    );
    expect(
      (await fixture.registry.ensureMounted(specialized, new AbortController().signal)).path,
    ).toBe(resolve(fixture.root, userId, specialized.workspaceId));
  });

  it("fails closed when another volume occupies the canonical path", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    fixture.portableFs.seed(resolve(fixture.root, plan.workspaceId), "other_volume", "other");

    await expect(
      fixture.registry.ensureMounted(plan, new AbortController().signal),
    ).rejects.toThrow(/occupied by PortableFS volume other_volume/u);
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.portableFs.unmountCalls).toEqual([]);
  });

  it("fails closed when the expected volume is mounted at another path", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    fixture.portableFs.seed(resolve(fixture.root, "other"), plan.volumeId, "other");

    await expect(
      fixture.registry.ensureMounted(plan, new AbortController().signal),
    ).rejects.toThrow(/already mounted at/u);
    expect(fixture.portableFs.unmountCalls).toEqual([]);
  });

  it("fails closed when an adopted Workspace resolves to another canonical path", async () => {
    const fixture = await registryFixture("owner-scoped");
    const plan = mountPlan({ createdBy: createId("user") });
    await fixture.registry.ensureMounted(plan, new AbortController().signal);

    await expect(
      fixture.registry.ensureMounted(
        { ...plan, createdBy: createId("user") },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/not canonical path/u);
    expect(fixture.portableFs.mountCalls).toHaveLength(1);
  });

  it("rejects a canonical path nested below another PortableFS mount", async () => {
    const fixture = await registryFixture("owner-scoped");
    const plan = mountPlan();
    fixture.portableFs.seed(resolve(fixture.root, plan.createdBy), "parent_volume", "parent");

    await expect(
      fixture.registry.ensureMounted(plan, new AbortController().signal),
    ).rejects.toThrow(/nested mounts are not supported/u);
  });

  it("adopts a live mount after restart without exchanging another grant", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    await fixture.registry.ensureMounted(plan, new AbortController().signal);
    const restarted = fixture.createRegistry();

    await restarted.adoptExisting();

    expect(restarted.inventory()).toEqual(fixture.registry.inventory());
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    await restarted.ensureMounted(plan, new AbortController().signal);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("detaches a live mount that has no persisted record", async () => {
    const fixture = await registryFixture();
    const workspaceId = createId("workspace");
    const path = resolve(fixture.root, workspaceId);
    fixture.portableFs.seed(path, "adopted_volume", "adopted");

    await fixture.registry.adoptExisting();

    expect(fixture.portableFs.unmountCalls).toEqual([path]);
    expect(fixture.registry.inventory()).toEqual([]);
  });

  it("adopts a Main mount only from its matching persisted record", async () => {
    const fixture = await registryFixture("owner-scoped");
    const plan = mountPlan({ createdBy: createId("user"), workspaceKind: "main" });
    await fixture.registry.ensureMounted(plan, new AbortController().signal);
    const restarted = fixture.createRegistry();

    await restarted.adoptExisting();

    expect(restarted.inventory()).toEqual(fixture.registry.inventory());
    expect(fixture.portableFs.unmountCalls).toEqual([]);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    await restarted.ensureMounted(plan, new AbortController().signal);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it("detaches unhealthy mounts under the configured root during adoption", async () => {
    const fixture = await registryFixture();
    const path = resolve(fixture.root, createId("workspace"));
    fixture.portableFs.seed(path, "unhealthy_volume", "unhealthy", {
      alive: false,
      health: "stale",
    });

    await fixture.registry.adoptExisting();

    expect(fixture.portableFs.unmountCalls).toEqual([path]);
    expect(fixture.registry.inventory()).toEqual([]);
  });

  it("remounts on demand when a recorded mount disappears from PortableFS inventory", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    const signal = new AbortController().signal;
    await fixture.registry.ensureMounted(plan, signal);
    fixture.portableFs.lose(resolve(fixture.root, plan.workspaceId));

    await fixture.registry.ensureMounted(plan, signal);

    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.portableFs.mountCalls).toHaveLength(2);
  });

  it("performs verified idempotent detach and credential cleanup", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    await fixture.registry.ensureMounted(plan, new AbortController().signal);

    await fixture.registry.detach(plan.workspaceId);
    await fixture.registry.detach(plan.workspaceId);

    expect(fixture.portableFs.unmountCalls).toEqual([resolve(fixture.root, plan.workspaceId)]);
    expect(fixture.registry.inventory()).toEqual([]);
    expect(await readdir(resolve(fixture.runtimeDirectory, "workspace-mounts"))).toEqual([]);
  });

  it.each(["single-owner", "owner-scoped"] as const)(
    "replaces a revoked mount with fresh authorization in %s workspaces",
    async (namespace) => {
      const fixture = await registryFixture(namespace);
      const plan = mountPlan({ workspaceKind: "main" });
      const signal = new AbortController().signal;
      const { path } = await fixture.registry.ensureMounted(plan, signal);
      fixture.portableFs.update(path, { health: "revoked", alive: true });
      fixture.fetch.mockImplementation(async () =>
        Response.json({
          ...exchangeResponse(plan.volumeId),
          automaticReauthorization: {
            ...exchangeResponse(plan.volumeId).automaticReauthorization,
            enrollmentId: "replacement-enrollment",
          },
        }),
      );

      await Promise.all([
        fixture.registry.ensureMounted(plan, signal),
        fixture.registry.ensureMounted(plan, signal),
      ]);

      expect(fixture.portableFs.unmountCalls).toEqual([path]);
      expect(fixture.portableFs.mountCalls).toHaveLength(2);
      expect(fixture.registry.inventory()[0]?.enrollmentId).toBe("replacement-enrollment");
    },
  );

  it("does not detach a revoked mount with a different enrollment", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    const signal = new AbortController().signal;
    const { path } = await fixture.registry.ensureMounted(plan, signal);
    fixture.portableFs.update(path, { health: "revoked", mountEnrollmentId: "someone-else" });
    await expect(fixture.registry.ensureMounted(plan, signal)).rejects.toThrow(
      "different enrollment",
    );
    await expect(fixture.registry.detach(plan.workspaceId)).rejects.toThrow("different enrollment");
    expect(fixture.portableFs.unmountCalls).toEqual([]);
  });

  it("keeps credentials and refuses remount when withdrawal did not remove the old mount", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    const signal = new AbortController().signal;
    const { path } = await fixture.registry.ensureMounted(plan, signal);
    fixture.portableFs.update(path, { health: "revoked" });
    vi.spyOn(fixture.portableFs, "unmount").mockResolvedValue({
      mountPath: path,
      tracked: true,
      unmounted: true,
    });
    await expect(fixture.registry.ensureMounted(plan, signal)).rejects.toThrow("remains present");
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(
      await readdir(resolve(fixture.runtimeDirectory, "workspace-mounts", plan.workspaceId)),
    ).toContain("mount.json");
  });

  it("waits for PortableFS to prove renewal before reporting a mount ready", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    fixture.portableFs.renewed = false;
    let ready = false;
    const operation = fixture.registry
      .ensureMounted(plan, new AbortController().signal)
      .then(() => {
        ready = true;
      });
    await vi.waitUntil(() => fixture.portableFs.mountCalls.length === 1);
    expect(ready).toBe(false);
    fixture.portableFs.update(resolve(fixture.root, plan.workspaceId), {
      lastReauthorizationAtMs: Date.now(),
    });
    await operation;
    expect(ready).toBe(true);
  });

  it("does not bypass a Host access revocation when replacing an expired mount", async () => {
    const fixture = await registryFixture();
    const plan = mountPlan();
    const signal = new AbortController().signal;
    const { path } = await fixture.registry.ensureMounted(plan, signal);
    fixture.portableFs.update(path, { health: "credential-expired" });
    fixture.fetch.mockImplementation(async () => new Response(null, { status: 403 }));
    await expect(fixture.registry.ensureMounted(plan, signal)).rejects.toThrow();
    expect(fixture.portableFs.mountCalls).toHaveLength(1);
    expect((await fixture.portableFs.listMounts()).mounts).toEqual([]);
  });

  it("withdraws a new mount when startup is canceled during renewal readiness", async () => {
    const fixture = await registryFixture();
    fixture.portableFs.renewed = false;
    const controller = new AbortController();
    const operation = fixture.registry.ensureMounted(mountPlan(), controller.signal);
    const rejected = expect(operation).rejects.toThrow("Run canceled");
    await vi.waitUntil(() => fixture.portableFs.mountCalls.length === 1);
    controller.abort(new Error("Run canceled"));
    await rejected;
    expect((await fixture.portableFs.listMounts()).mounts).toEqual([]);
  });

  it("cleans up and reports unreachable renewal instead of starting a doomed mount", async () => {
    vi.useFakeTimers();
    const fixture = await registryFixture();
    fixture.portableFs.renewed = false;
    const operation = fixture.registry.ensureMounted(mountPlan(), new AbortController().signal);
    const rejected = expect(operation).rejects.toThrow("could not verify automatic mount renewal");
    await vi.waitUntil(() => fixture.portableFs.mountCalls.length === 1);
    await vi.advanceTimersByTimeAsync(31_000);
    await rejected;
    expect((await fixture.portableFs.listMounts()).mounts).toEqual([]);
    expect(fixture.registry.inventory()).toEqual([]);
  });

  it("detaches every adopted mount during drain", async () => {
    const fixture = await registryFixture();
    const first = mountPlan();
    const second = mountPlan();
    await fixture.registry.ensureMounted(first, new AbortController().signal);
    await fixture.registry.ensureMounted(second, new AbortController().signal);

    await fixture.registry.detachAll();

    expect(fixture.portableFs.unmountCalls).toHaveLength(2);
    expect(fixture.registry.inventory()).toEqual([]);
  });
});

class FakePortableFsRunner implements PortableFsRunner {
  renewed = true;
  features = ["hosted-automatic-mount-reauthorization-v2"];
  readonly mountCalls: PortableFsMountInput[] = [];
  readonly unmountCalls: string[] = [];
  readonly #mounts = new Map<string, PortableFsMountStatus>();

  async checkMountSupport() {
    return {
      facts: { state: "unverified" as const, summary: "ready", transport: "fuse" as const },
      schemaVersion: 1 as const,
    };
  }

  async explainRoute(path: string) {
    const volumeId = PortableFsVolumeIdSchema.parse("test_volume");
    return {
      mountPath: path,
      path,
      revision: "0".repeat(64),
      storage: "shared" as const,
      volumeId,
      volumePath: "/",
    };
  }

  async getVersion() {
    return { features: this.features, version: "test" };
  }

  async listMounts(): Promise<PortableFsMountList> {
    return { mounts: [...this.#mounts.values()] };
  }

  async mount(input: PortableFsMountInput) {
    const mountPath = resolve(input.mountPath);
    if (this.#mounts.has(mountPath)) throw new Error("mount path is occupied");
    if ([...this.#mounts.values()].some((row) => row.volumeId === input.volumeId)) {
      throw new Error("one live mount per volume is supported on this machine");
    }
    if ([...this.#mounts.keys()].some((path) => pathsOverlap(path, mountPath))) {
      throw new Error("nested mounts are not supported");
    }
    if ((await readdir(mountPath)).length > 0) throw new Error("mount directory is not empty");
    this.mountCalls.push(input);
    this.seed(mountPath, input.volumeId, input.automaticReauthorization.enrollmentId);
    return {
      authorizationSessionId: "1234567890123456789012",
      mountPath,
      ok: true as const,
      pid: 42,
      strategy: "fuse" as const,
      volumeId: PortableFsVolumeIdSchema.parse(input.volumeId),
    };
  }

  async unmount(input: { readonly mountPath: string }) {
    const mountPath = resolve(input.mountPath);
    this.unmountCalls.push(mountPath);
    const row = this.#mounts.get(mountPath);
    this.#mounts.delete(mountPath);
    return {
      mountPath,
      tracked: Boolean(row),
      unmounted: true as const,
      ...(row ? { volumeId: row.volumeId } : {}),
    };
  }

  seed(
    mountPath: string,
    volumeId: string,
    enrollmentId: string,
    overrides: Partial<PortableFsMountStatus> = {},
  ): void {
    mountPath = resolve(mountPath);
    if (this.#mounts.has(mountPath)) throw new Error("mount path is occupied");
    if ([...this.#mounts.values()].some((row) => row.volumeId === volumeId)) {
      throw new Error("one live mount per volume is supported on this machine");
    }
    if ([...this.#mounts.keys()].some((path) => pathsOverlap(path, mountPath))) {
      throw new Error("nested mounts are not supported");
    }
    this.#mounts.set(mountPath, {
      alive: true,
      health: "live",
      lastReauthorizationAtMs: this.renewed ? Date.now() : 0,
      mountEnrollmentId: enrollmentId,
      mountPath,
      pid: 42,
      startedAtMs: Date.now(),
      strategy: "fuse",
      volumeId: volumeId as PortableFsMountStatus["volumeId"],
      ...overrides,
    });
  }

  lose(mountPath: string): void {
    this.#mounts.delete(resolve(mountPath));
  }

  update(path: string, patch: Partial<PortableFsMountStatus>): void {
    const row = this.#mounts.get(path);
    if (!row) throw new Error("missing mount");
    this.#mounts.set(path, { ...row, ...patch });
  }
}

async function registryFixture(namespace: "single-owner" | "owner-scoped" = "single-owner") {
  const directory = await mkdtemp(join(tmpdir(), "opensteer-workspace-registry-test-"));
  directories.push(directory);
  const root = resolve(directory, "workspaces");
  const runtimeDirectory = resolve(directory, "runtime");
  const portableFs = new FakePortableFsRunner();
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("Authorization");
    if (authorization !== "Bearer opaque-exchange-token") {
      return new Response(null, { status: 401 });
    }
    const url = new URL(input instanceof Request ? input.url : input);
    return Response.json(exchangeResponse(url.searchParams.get("volumeId") ?? ""));
  });
  const identityIssuer: MountIdentityIssuer = {
    create: async ({ directory: identityDirectory }) => {
      const privateKeyPath = join(identityDirectory, "client-private-key.pem");
      await writeFile(privateKeyPath, "private", { mode: 0o600 });
      return {
        csrPem: "-----BEGIN CERTIFICATE REQUEST-----\ntest\n-----END CERTIFICATE REQUEST-----\n",
        privateKeyPath,
      };
    },
  };
  const createRegistry = (request: typeof globalThis.fetch = fetch) =>
    new WorkspaceMountRegistry({
      fetch: request,
      identityIssuer,
      mode: "development",
      namespace,
      portableFs,
      root,
      runnerId: createId("runner"),
      runtimeDirectory,
    });
  return { createRegistry, fetch, portableFs, registry: createRegistry(), root, runtimeDirectory };
}

function mountPlan(
  overrides: Partial<PortableFsWorkspaceExecutionAccessPlan> = {},
): PortableFsWorkspaceExecutionAccessPlan {
  const volumeId = overrides.volumeId ?? `workspace_volume_${Math.random().toString(36).slice(2)}`;
  return {
    createdBy: createId("user"),
    exchangeToken: "opaque-exchange-token",
    exchangeUrl: `http://127.0.0.1:4310/internal/v1/mount-grants/exchange?volumeId=${volumeId}`,
    generation: 1,
    kind: "portablefs",
    volumeId,
    workspaceId: createId("workspace"),
    workspaceKind: "specialized",
    ...overrides,
  };
}

function exchangeResponse(volumeId: string) {
  return {
    automaticReauthorization: {
      authorityGeneration: 9,
      enrollmentCertificatePem: certificate,
      enrollmentId: "enrollment-1",
      manager: {
        caCertificatePem: certificate,
        serverName: "manager.test",
        url: "https://manager.test",
      },
    },
    authority: {
      address: "portablefs.internal:443",
      caCertificatePem: certificate,
      serverName: "portablefs.internal",
      transport: "tls-private-ca",
    },
    capability: "v1.payload.signature",
    clientCertificatePem: certificate,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    volumeId,
  };
}

function pathsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    left === right ||
    (leftToRight !== "" && !leftToRight.startsWith("..")) ||
    (rightToLeft !== "" && !rightToLeft.startsWith(".."))
  );
}
