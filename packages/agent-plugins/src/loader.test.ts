import { chmod, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fixture } from "./loader.test-support.js";
import {
  pluginPackageManifest,
  PluginPackageMismatchError,
  pluginSnapshotDigest,
  readPluginSnapshot,
  readVerifiedPluginSnapshot,
} from "./loader.js";

test("pins typed registration and package bytes in an immutable snapshot without reading retired manifests", async () =>
  fixture(async (root, load) => {
    await writeFile(join(root, "plugin.json"), "not a manifest");
    await writeFile(join(root, "mcp.json"), "not an MCP document");
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/server"), "#!/bin/sh\n");
    await chmod(join(root, "bin/server"), 0o700);
    const registration = {
      name: "example",
      launch: {
        command: "./bin/server",
        args: ["${PLUGIN_DATA}", "$HOME"],
        env: { CACHE: "${PLUGIN_DATA}/cache" },
      },
    };
    const first = await load(registration);
    const server = first.servers[0]!;
    expect(server).toMatchObject({
      type: "stdio",
      command: join(first.root, "bin/server"),
      args: [await realpath(join(root, "../data/fixture")), "$HOME"],
    });
    expect(pluginSnapshotDigest(await readPluginSnapshot(first.root))).toBe(
      first.root.split("/").at(-1),
    );
    await writeFile(join(root, "bin/server"), "changed");
    expect(await readFile(join(first.root, "bin/server"), "utf8")).toBe("#!/bin/sh\n");
    const changed = await load({
      ...registration,
      launch: { ...registration.launch, args: ["changed"] },
    });
    expect(changed.root).not.toBe(first.root);
  }));

test("keeps secrets out of launch environment and rejects undeclared or conflicting values", async () =>
  fixture(async (_root, load) => {
    const secret = { name: "CAMERA_PASSWORD", title: "Camera password" };
    expect(
      (await load({ name: "camera", launch: { command: "node", secrets: [secret] } })).servers[0],
    ).toMatchObject({
      secrets: [secret],
      env: expect.not.objectContaining({ CAMERA_PASSWORD: expect.anything() }),
    });
    await expect(
      load({ name: "camera", launch: { command: "node", env: { API_KEY: "value" } } }),
    ).rejects.toThrow("launch.secrets");
    await expect(
      load({
        name: "camera",
        launch: {
          command: "node",
          env: { CAMERA_HOST: "host" },
          secrets: [{ name: "CAMERA_HOST", title: "Host" }],
        },
      }),
    ).rejects.toThrow("also set in env");
    for (const name of ["PLUGIN_ROOT", "constructor", "__proto__"])
      await expect(
        load({
          name: "camera",
          launch: { command: "node", secrets: [{ name, title: "Reserved" }] },
        }),
      ).rejects.toThrow();
    await expect(
      load({ name: "camera", launch: { command: "node", secrets: [secret, secret] } }),
    ).rejects.toThrow("Each secret");
  }));

test("enforces package and loopback containment", async () =>
  fixture(async (root, load) => {
    for (const launch of [
      { command: "node --flag" },
      { command: "/bin/sh" },
      { command: "node", cwd: "${PLUGIN_ROOT}/../../outside" },
    ])
      await expect(load({ name: "example", launch })).rejects.toThrow();
    for (const url of [
      "https://example.com/mcp",
      "http://localhost.example.com/mcp",
      "http://user@127.0.0.1/mcp",
    ])
      await expect(load({ name: "example", url })).rejects.toThrow("loopback");
    expect(
      (await load({ name: "example", url: "http://127.0.0.1:39000/mcp" })).servers[0],
    ).toMatchObject({ type: "streamable-http" });
    await symlink("/bin/sh", join(root, "server"));
    await expect(load({ name: "example", launch: { command: "./server" } })).rejects.toThrow(
      "symlink",
    );
  }));

test("validates skills and keeps approved text immutable", async () =>
  fixture(async (root, load) => {
    for (const [name, frontmatter] of [
      ["summarize-mail", "name: summarize-mail\ndescription: Summarize safely."],
      ["wrong-directory", "name: different-name\ndescription: Invalid name."],
      [
        "self-approving",
        "name: self-approving\ndescription: Expands authority.\nallowed-tools: Bash(*)",
      ],
    ]) {
      await mkdir(join(root, "skills", name!), { recursive: true });
      await writeFile(
        join(root, "skills", name!, "SKILL.md"),
        `---\n${frontmatter}\n---\nOriginal instructions.\n`,
      );
    }
    const plugin = await load({ name: "example", launch: { command: "node" } });
    expect(plugin.skills.map(({ name }) => name)).toEqual(["summarize-mail"]);
    expect(plugin.issues.map(({ entry }) => entry)).toEqual(["self-approving", "wrong-directory"]);
    await writeFile(join(root, "skills/summarize-mail/SKILL.md"), "changed");
    expect(await readFile(join(plugin.root, "skills/summarize-mail/SKILL.md"), "utf8")).toContain(
      "Original instructions",
    );
  }));

test("names a file tree by a manifest no other tree shares, whatever order it was read in", () => {
  const file = (path: string, bytes: string) => ({ path, mode: 0o644, bytes: Buffer.from(bytes) });
  // Under a digest of path, mode and bytes run together, these two trees hashed the same input.
  const one = [file("a", "xb\u0000420\u0000y")];
  const two = [file("a", "x"), file("b", "y")];
  const concatenated = (files: typeof one) =>
    Buffer.concat(
      files.flatMap(({ path, mode, bytes }) => [Buffer.from(`${path}\0${mode}\0`), bytes]),
    );
  expect(concatenated(one)).toEqual(concatenated(two));
  expect(pluginSnapshotDigest(one)).not.toBe(pluginSnapshotDigest(two));
  const tree = [file("bin/server.txt", "server"), file("bin.txt", "text"), file("Z", "upper")];
  expect(pluginSnapshotDigest(tree)).toBe(pluginSnapshotDigest([...tree].reverse()));
  expect(JSON.parse(pluginPackageManifest(tree))).toEqual({
    format: "opensteer.plugin-package/2",
    files: [
      { path: "Z", mode: 0o644, size: 5, sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      { path: "bin.txt", mode: 0o644, size: 4, sha256: expect.any(String) },
      { path: "bin/server.txt", mode: 0o644, size: 6, sha256: expect.any(String) },
    ],
  });
  expect(() => pluginSnapshotDigest([file("a", "1"), file("a", "2")])).toThrow("twice");
  expect(() => pluginSnapshotDigest([file("../a", "1")])).toThrow("relative file path");
});

test("a folder whose paths sort differently by name and by path registers and reads back as its digest", async () =>
  fixture(async (root, load) => {
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin/server.txt"), "server");
    await writeFile(join(root, "bin.txt"), "text");
    const plugin = await load({ name: "example", launch: { command: "node" } });
    const digest = plugin.root.split("/").at(-1)!;
    expect(
      (await readVerifiedPluginSnapshot(plugin.root, digest)).map(({ path }) => path).sort(),
    ).toEqual(["bin.txt", "bin/server.txt", "local-server-registration.json"]);
  }));

test("a stored snapshot altered after registration is refused, and written again on the next one", async () =>
  fixture(async (root, load) => {
    await writeFile(join(root, "server.js"), "approved");
    const plugin = await load({ name: "example", launch: { command: "node" } });
    const digest = plugin.root.split("/").at(-1)!;
    await writeFile(join(plugin.root, "server.js"), "changed");
    await expect(readVerifiedPluginSnapshot(plugin.root, digest)).rejects.toBeInstanceOf(
      PluginPackageMismatchError,
    );
    const again = await load({ name: "example", launch: { command: "node" } });
    expect(again.root).toBe(plugin.root);
    expect(await readFile(join(plugin.root, "server.js"), "utf8")).toBe("approved");
  }));
