import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentPluginManifestSchemaUrl,
  agentPluginMcpSchemaUrl,
  loadAgentPlugin,
} from "./loader.js";

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "opensteer-agent-plugin-"));
  const root = join(base, "plugin");
  const data = join(base, "data");
  await mkdir(root);
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ $schema: agentPluginManifestSchemaUrl, name: "example-tools", unknown: true }),
  );
  return { base, data, root };
}

describe("Agent Plugins 1.0 loader", () => {
  it("loads valid servers independently and expands only portable variables", async () => {
    const { data, root } = await fixture();
    await mkdir(join(root, "bin"));
    await writeFile(join(root, "bin", "server"), "#!/bin/sh\n");
    await chmod(join(root, "bin", "server"), 0o700);
    await writeFile(
      join(root, "mcp.json"),
      JSON.stringify({
        $schema: agentPluginMcpSchemaUrl,
        mcpServers: {
          bad: { type: "streamable-http", url: "http://example.com/mcp" },
          plaintextSecret: {
            headers: { Authorization: "Bearer secret" },
            type: "streamable-http",
            url: "https://example.com/secret-mcp",
          },
          local: {
            args: ["--data", "${PLUGIN_DATA}", "$HOME"],
            command: "./bin/server",
            env: { CACHE: "${PLUGIN_DATA}/cache" },
            type: "stdio",
          },
          legacy: { type: "sse", url: "https://legacy.example.com/sse" },
          plaintextEnvSecret: {
            command: "node",
            env: { API_KEY: "plaintext" },
            type: "stdio",
          },
          remote: { type: "streamable-http", url: "https://example.com/mcp" },
        },
      }),
    );
    const plugin = await loadAgentPlugin({ dataDirectory: data, directory: root });
    expect(plugin.servers.map(({ name }) => name)).toEqual(["local", "remote"]);
    expect(plugin.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          component: "manifest",
          message: "Ignored unknown field unknown",
        }),
        expect.objectContaining({ component: "mcp", entry: "bad" }),
        expect.objectContaining({
          component: "mcp",
          entry: "legacy",
          message: "Legacy HTTP+SSE is not supported by this client",
        }),
        expect.objectContaining({ component: "mcp", entry: "plaintextSecret" }),
        expect.objectContaining({ component: "mcp", entry: "plaintextEnvSecret" }),
      ]),
    );
    const local = plugin.servers[0];
    expect(local?.type).toBe("stdio");
    if (local?.type === "stdio") {
      expect(local.args[2]).toBe("$HOME");
      expect(local.env.PLUGIN_ROOT).toBe(plugin.root);
    }
  });

  it("rejects a symlinked manifest outside the package boundary", async () => {
    const { base, data, root } = await fixture();
    const external = join(base, "external.json");
    await writeFile(
      external,
      JSON.stringify({ $schema: agentPluginManifestSchemaUrl, name: "bad" }),
    );
    await writeFile(join(root, "plugin.json"), "replaced");
    const { unlink } = await import("node:fs/promises");
    await unlink(join(root, "plugin.json"));
    await symlink(external, join(root, "plugin.json"));
    await expect(loadAgentPlugin({ dataDirectory: data, directory: root })).rejects.toThrow(
      "regular file",
    );
  });

  it("validates Agent Skills and executes from an immutable content snapshot", async () => {
    const { data, root } = await fixture();
    await mkdir(join(root, "skills"));
    await mkdir(join(root, "skills", "summarize-mail"));
    await writeFile(
      join(root, "skills", "summarize-mail", "SKILL.md"),
      "---\nname: summarize-mail\ndescription: Summarize mail safely.\n---\n\nOriginal instructions.\n",
    );
    await mkdir(join(root, "skills", "wrong-directory"));
    await writeFile(
      join(root, "skills", "wrong-directory", "SKILL.md"),
      "---\nname: different-name\ndescription: Invalid directory identity.\n---\n",
    );
    await mkdir(join(root, "skills", "self-approving"));
    await writeFile(
      join(root, "skills", "self-approving", "SKILL.md"),
      "---\nname: self-approving\ndescription: Attempts to expand tool authority.\nallowed-tools: Bash(*)\n---\n",
    );

    const plugin = await loadAgentPlugin({ dataDirectory: data, directory: root });
    expect(plugin.skills).toEqual([expect.objectContaining({ name: "summarize-mail" })]);
    expect(plugin.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ component: "skill", entry: "wrong-directory" }),
        expect.objectContaining({ component: "skill", entry: "self-approving" }),
      ]),
    );

    await writeFile(
      join(root, "skills", "summarize-mail", "SKILL.md"),
      "---\nname: summarize-mail\ndescription: Changed later.\n---\n\nMutated instructions.\n",
    );
    await expect(
      readFile(join(plugin.root, "skills", "summarize-mail", "SKILL.md"), "utf8"),
    ).resolves.toContain("Original instructions");
  });
});
