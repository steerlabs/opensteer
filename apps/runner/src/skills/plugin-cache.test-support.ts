import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, type Mock } from "vitest";
import { localServerRegistrationFile, pluginSnapshotDigest } from "@opensteer/agent-plugins";
import { LocalMcpServers } from "../computer-apps/local-mcp-servers.js";

/** State directories the fixtures made; each test file removes them after each test. */
export const fixtureDirectories: string[] = [];

export async function fixture() {
  const stateDirectory = await realpath(await mkdtemp(join(tmpdir(), "plugin-cache-")));
  fixtureDirectories.push(stateDirectory);
  const files = [
    {
      path: "skills/test/SKILL.md",
      mode: 0o600,
      bytes: Buffer.from(
        "---\nname: test\ndescription: Test\n---\nRun ${PLUGIN_ROOT}/scripts/test.sh",
      ),
    },
    { path: "scripts/test.sh", mode: 0o700, bytes: Buffer.from("echo test") },
  ];
  // Loader traversal orders scripts before skills.
  files.sort((a, b) => a.path.localeCompare(b.path));
  const digest = pluginSnapshotDigest(files);
  const snapshot = files.map(({ path, mode, bytes }) => ({
    path,
    mode,
    content: bytes.toString("base64"),
  }));
  return { stateDirectory, digest, snapshot };
}

export async function launchFixture(extra: { path: string; mode: number; bytes: Buffer }[] = []) {
  const f = await fixture();
  const script = {
    path: "bin/server.cjs",
    mode: 0o600,
    bytes: Buffer.from(
      'require("node:fs").writeFileSync(process.env.PLUGIN_DATA+"/observed.json",JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,arg:process.argv[2]})); require("node:fs").writeFileSync(process.env.PLUGIN_ROOT+"/bin/server.cjs","rewritten by the server"); process.stdin.resume();',
    ),
  };
  // The launch the package registers, as the Host writes it into every local-server package.
  const registration = {
    path: localServerRegistrationFile,
    mode: 0o600,
    bytes: Buffer.from(
      JSON.stringify({
        name: "test",
        launch: {
          command: "node",
          args: ["${PLUGIN_ROOT}/bin/server.cjs", "${PLUGIN_DATA}/arg"],
          secrets: [{ name: "TEST_TOKEN", title: "Test token" }],
        },
      }),
    ),
  };
  // `bin.cjs` sorts before `bin/` by path and after `bin` by name.
  const files = [
    script,
    { path: "bin.cjs", mode: 0o600, bytes: Buffer.from("") },
    registration,
    ...extra,
  ];
  const digest = pluginSnapshotDigest(files);
  const snapshot = files.map(({ path, mode, bytes }) => ({
    path,
    mode,
    content: bytes.toString("base64"),
  }));
  const delivered = { snapshot };
  const fetchSnapshot: Mock<() => Promise<Response>> = vi.fn(
    async () => new Response(JSON.stringify(delivered.snapshot)),
  );
  vi.stubGlobal("fetch", fetchSnapshot);
  const mcp = new LocalMcpServers({ stateDirectory: f.stateDirectory });
  const frames: { type: string; error?: { message: string } }[] = [];
  mcp.attach(async (frame) => {
    frames.push(frame as (typeof frames)[number]);
  });
  /** Opens a session of the registered launch, or of one changed from it. */
  const open = (
    sessionId: string,
    changed: {
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    } = {},
  ) =>
    mcp.open({
      type: "host.integrations.mcp.open" as const,
      serverId: "server_test",
      sessionId,
      launch: {
        type: "stdio" as const,
        pluginId: "test",
        packageDigest: digest,
        command: "node",
        cwd: "${PLUGIN_ROOT}",
        args: ["${PLUGIN_ROOT}/bin/server.cjs", "${PLUGIN_DATA}/arg"],
        env: {},
        ...changed,
      },
      packageSource: { url: "https://host/package", token: "test" },
    } as Parameters<typeof mcp.open>[0]);
  const data = join(f.stateDirectory, "plugin-data/test");
  const observed = () =>
    vi.waitFor(
      async () =>
        JSON.parse(await readFile(join(data, "observed.json"), "utf8")) as {
          cwd: string;
          root: string;
          arg: string;
        },
      { timeout: 2000 },
    );
  return {
    ...f,
    mcp,
    frames,
    open,
    observed,
    digest,
    snapshot,
    delivered,
    fetchSnapshot,
    script,
    data,
  };
}
