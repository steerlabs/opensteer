import { createId } from "@opensteer/core";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { LocalWorkspaceRegistry, type RegistryDocument } from "./registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(namespace: "single-owner" | "owner-scoped") {
  const base = await mkdtemp(path.join(tmpdir(), "project-relocation-"));
  roots.push(base);
  const ownerEnvironmentId = createId("environment");
  const createdBy = createId("user");
  const options = {
    namespace:
      namespace === "single-owner" ? { kind: namespace, ownerEnvironmentId } : { kind: namespace },
    registryFilePath: path.join(base, "private", "registry.json"),
    visibleRootPath: path.join(base, "files"),
  };
  const registry = new LocalWorkspaceRegistry(options);
  await registry.preflight();
  const provision = (kind: "main" | "project") =>
    registry.provision({
      bindingId: createId("workspaceBinding"),
      generation: 1,
      idempotencyKey: crypto.randomUUID(),
      fingerprint: { createdBy, ownerEnvironmentId, workspaceId: createId("workspace"), kind },
    });
  const main = await provision("main");
  const project = await provision("project");
  const source = registry.resolvePath(project);
  const target = path.join(registry.resolvePath(main), "Projects", "research");
  await writeFile(path.join(source, "keep.txt"), "precious data");
  const move = vi.fn(async (input: { root: string; path: string; destination: string }) => {
    const destination = path.join(input.root, input.destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await rename(path.join(input.root, input.path), destination);
  });
  const identity = async (input: { root: string; path: string }) => {
    const stat = await lstat(path.join(input.root, input.path), { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not a real directory");
    return {
      kind: "posix" as const,
      fileId: String(stat.ino),
      volumeId: process.platform === "darwin" ? "0" : String(stat.dev),
    };
  };
  const reopen = () =>
    new LocalWorkspaceRegistry({
      ...options,
      filesystemAuthority: {
        directoryIdentity: identity,
        relocateDirectory: move,
        ensureDirectory: vi.fn(),
        ensureRoot: vi.fn(),
        list: vi.fn(),
      },
    });
  const input = {
    bindingId: project.bindingId,
    generation: project.generation,
    workspaceId: project.workspaceId,
    slug: "research",
  };
  const document = async () =>
    JSON.parse(await readFile(options.registryFilePath, "utf8")) as RegistryDocument;
  return { registry, reopen, options, main, project, source, target, move, input, document };
}

it.each(["single-owner", "owner-scoped"] as const)(
  "relocates %s Projects preserving data and binding identity; retry is idempotent",
  async (namespace) => {
    const f = await fixture(namespace);
    await f.reopen().relocate(f.input);
    await f.reopen().relocate(f.input);
    expect(f.move).toHaveBeenCalledOnce();
    expect(await readFile(path.join(f.target, "keep.txt"), "utf8")).toBe("precious data");
    const binding = await f.reopen().getReadyBinding(f.input);
    expect(binding.bindingId).toBe(f.project.bindingId);
    expect(binding.filesystemIdentity).toEqual(f.project.filesystemIdentity);
    expect(binding.relocation?.state).toBe("bound");
    await expect(
      f.reopen().provision({
        bindingId: f.project.bindingId,
        generation: f.project.generation,
        idempotencyKey: f.project.idempotencyKey,
        fingerprint: { ...f.project.provisionFingerprint, slug: "research" },
      }),
    ).resolves.toMatchObject({ bindingId: f.project.bindingId });
  },
);

it.each(["planned", "rename", "renamed", "bound"])("resumes a crash at %s", async (step) => {
  const f = await fixture("single-owner");
  if (step === "rename")
    f.move.mockImplementationOnce(async (input) => {
      await mkdir(path.dirname(f.target), { recursive: true });
      await rename(path.join(input.root, input.path), f.target);
      throw new Error("crash after rename");
    });
  else f.move.mockRejectedValueOnce(new Error("crash before rename"));
  await expect(f.reopen().relocate(f.input)).rejects.toThrow(/crash/);
  await expect(f.reopen().getReadyBinding(f.input)).rejects.toThrow(/relocat/);
  if (step === "renamed" || step === "bound") {
    await mkdir(path.dirname(f.target), { recursive: true });
    await rename(f.source, f.target);
    const doc = await f.document();
    const binding = doc.bindings.find((b) => b.bindingId === f.input.bindingId)!;
    binding.relocation!.state = step;
    if (step === "bound") binding.relativeSegments = binding.relocation!.target;
    await writeFile(f.options.registryFilePath, JSON.stringify(doc));
  }
  await f.reopen().relocate(f.input);
  expect(await readFile(path.join(f.target, "keep.txt"), "utf8")).toBe("precious data");
  expect((await f.reopen().getReadyBinding(f.input)).relocation?.state).toBe("bound");
});

it("refuses an occupied destination and keeps the original bytes", async () => {
  const f = await fixture("single-owner");
  await mkdir(f.target, { recursive: true });
  await writeFile(path.join(f.target, "other.txt"), "other");
  await expect(f.reopen().relocate(f.input)).rejects.toThrow(/occupied/);
  expect(f.move).not.toHaveBeenCalled();
  expect(await readFile(path.join(f.source, "keep.txt"), "utf8")).toBe("precious data");
});

it.each(["missing", "symlink", "bound", "success"])("explicit adoption: %s", async (outcome) => {
  const f = await fixture("single-owner");
  if (outcome === "symlink") {
    await mkdir(path.dirname(f.target), { recursive: true });
    await symlink(f.source, f.target);
  }
  if (outcome === "success") {
    await mkdir(path.dirname(f.target), { recursive: true });
    await rename(f.source, f.target);
  }
  if (outcome === "bound") {
    const doc = await f.document();
    await mkdir(f.target, { recursive: true });
    const stat = await lstat(f.target, { bigint: true });
    doc.bindings.push({
      ...f.project,
      bindingId: createId("workspaceBinding"),
      workspaceId: createId("workspace"),
      idempotencyKey: crypto.randomUUID(),
      relativeSegments: [...f.main.relativeSegments, "Projects", "research"],
      filesystemIdentity: {
        kind: "posix",
        fileId: String(stat.ino),
        volumeId: process.platform === "darwin" ? "0" : String(stat.dev),
      },
    });
    await writeFile(f.options.registryFilePath, JSON.stringify(doc));
  }
  const result = f.reopen().relocate({ ...f.input, adopt: true });
  if (outcome === "success") {
    await result;
    expect((await f.reopen().getReadyBinding(f.input)).relocation?.state).toBe("bound");
  } else await expect(result).rejects.toThrow(outcome === "bound" ? /bound/ : undefined);
});
