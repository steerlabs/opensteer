/** Build all package inputs from this checkout and pinned public upstream sources. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runBounded } from "./command-runner.js";

const root = path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { readSigningMode, signingKeychainArguments, personalRuntimeSigningOptions } =
  require("../apps/desktop/scripts/signing-input.cjs") as typeof import("../apps/desktop/scripts/signing-input.cjs");
const { verifyAgentPhoneRelease, agentPhoneReceiptName } =
  require("./release-agent-phone.cjs") as typeof import("./release-agent-phone.cjs");
const { values } = parseArgs({
  options: { out: { type: "string" }, unsigned: { type: "boolean" } },
});
const out = path.resolve(z.string().min(1).parse(values.out));
const unsigned = values.unsigned === true;
if (process.platform !== "darwin" || process.arch !== "arm64") throw Error("Requires an arm64 Mac");
const mode = readSigningMode({ ...process.env, OPENSTEER_DESKTOP_RELEASE: unsigned ? "0" : "1" });
if (unsigned && mode.mode !== "development") throw Error("Unsigned proof refuses signing inputs");
const signal = new AbortController();
for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(name, () => signal.abort(Error(`Interrupted by ${name}`)));
const env: NodeJS.ProcessEnv = {
  ...process.env,
  OPENSTEER_DESKTOP_TARGET_OS: "darwin",
  OPENSTEER_DESKTOP_TARGET_ARCH: "arm64",
  OPENSTEER_DESKTOP_RELEASE: unsigned ? "0" : "1",
};
async function run(command: string, args: readonly string[], cwd = root, capture = false) {
  return runBounded(command, args, {
    cwd,
    env,
    signal: signal.signal,
    timeoutMs: 900_000,
    inheritOutput: !capture,
  });
}
const pnpm = z.string().min(1).parse(process.env.npm_execpath);
async function desktop(...args: string[]) {
  await run(process.execPath, [pnpm, "--dir", "apps/desktop", ...args]);
}
async function hash(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}
async function download(url: string, filename: string, digest: string) {
  await run("curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--retry",
    "3",
    "--output",
    filename,
    url,
  ]);
  if ((await hash(filename)) !== digest)
    throw Error(`Upstream digest mismatch: ${path.basename(filename)}`);
}
await mkdir(out, { recursive: true });
const version = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/u)
  .parse(JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version);
const sha = (await run("git", ["rev-parse", "HEAD"], root, true)).trim();
if ((await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root, true)).trim())
  throw Error("Build requires a clean checkout");
if (process.env.OPENSTEER_SOURCE_REVISION && process.env.OPENSTEER_SOURCE_REVISION !== sha)
  throw Error("Source revision differs from checkout");
Object.assign(env, { OPENSTEER_SOURCE_REVISION: sha, OPENSTEER_RELEASE_VERSION: version });

// Official distributions, pinned independently of the runner's installed packages.
await download(
  "https://nodejs.org/dist/v24.13.0/node-v24.13.0-darwin-arm64.tar.gz",
  path.join(out, "node.tgz"),
  "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
);
await run("tar", ["-xzf", path.join(out, "node.tgz"), "-C", out]);
await download(
  "https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2",
  path.join(out, "postgres.tar.bz2"),
  "dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979",
);
await run("tar", ["-xjf", path.join(out, "postgres.tar.bz2"), "-C", out]);
const postgres = path.join(out, "postgres");
const source = path.join(out, "postgresql-17.11");
await run(
  path.join(source, "configure"),
  [
    `--prefix=${postgres}`,
    "--without-icu",
    "--without-readline",
    "--without-zlib",
    "--without-lz4",
    "--without-zstd",
  ],
  source,
);
await run("make", ["-j4"], source);
await run("make", ["install"], source);
// Relocate our own build before the runtime's external-dependency gate checks it.
for (const directory of ["bin", "lib", "lib/postgresql"]) {
  const base = path.join(postgres, directory);
  for (const entry of await readdir(base, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(base, entry.name);
    const kind = await run("file", [file], root, true);
    if (!kind.includes("Mach-O")) continue;
    const libraries = (await run("otool", ["-L", file], root, true)).split("\n").slice(1);
    for (const line of libraries) {
      const dependency = line.trim().split(" (", 1)[0]!;
      if (!dependency.startsWith(postgres + "/")) continue;
      const relative = path.relative(base, dependency);
      await run("install_name_tool", ["-change", dependency, `@loader_path/${relative}`, file]);
    }
  }
}
await download(
  "https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-darwin-arm64.tgz",
  path.join(out, "cloudflared.tgz"),
  "a2f79ff7b9420aa537d74af239f376da170bbabeb529aec416002adac6a72e70",
);
await run("tar", ["-xzf", path.join(out, "cloudflared.tgz"), "-C", out]);
// The producer compiles from source before the release consumer verifies its digest.
const releaseMode = env.OPENSTEER_DESKTOP_RELEASE;
env.OPENSTEER_DESKTOP_RELEASE = "0";
await desktop("build:process-supervisor");
env.OPENSTEER_DESKTOP_RELEASE = releaseMode;
const supervisor = path.join(
  root,
  "apps/desktop/generated-native/darwin-arm64/opensteer-process-supervisor",
);
const cloudflared = path.join(out, "cloudflared");
for (const file of [supervisor, cloudflared]) {
  await run("chmod", ["u+w", file]);
  await run("codesign", [
    "--force",
    ...signingKeychainArguments(env),
    "--sign",
    mode.mode === "signed" ? mode.signing.identity : "-",
    ...personalRuntimeSigningOptions(mode.mode === "signed" ? mode.signing.identity : "-"),
    file,
  ]);
}
Object.assign(env, {
  OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: postgres,
  OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: path.join(out, "node-v24.13.0-darwin-arm64"),
  OPENSTEER_PERSONAL_RUNTIME_SOURCE: path.join(out, "runtime"),
  OPENSTEER_PERSONAL_RUNTIME_OUTPUT: path.join(out, "runtime"),
  OPENSTEER_PROCESS_SUPERVISOR_BINARY_SOURCE: supervisor,
  OPENSTEER_PROCESS_SUPERVISOR_BINARY_SHA256: await hash(supervisor),
  OPENSTEER_CLOUDFLARED_BINARY_SOURCE: cloudflared,
  OPENSTEER_CLOUDFLARED_BINARY_SHA256: await hash(cloudflared),
  OPENSTEER_CLOUDFLARED_RELEASE_VERSION: "2026.10.0",
});
if (unsigned) {
  await run(process.execPath, [pnpm, "build:agent-phone"]);
  await desktop("package:mac", "--unsigned");
} else {
  const phone = path.join(root, "apps/desktop/generated-resources/agent-phone");
  const receipt = path.join(phone, agentPhoneReceiptName);
  const digest = await hash(receipt);
  verifyAgentPhoneRelease(phone, receipt, { sourceRevision: sha, version, receiptSha256: digest });
  Object.assign(env, {
    OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT: receipt,
    OPENSTEER_AGENT_PHONE_RELEASE_RECEIPT_SHA256: digest,
  });
  await desktop("exec", "tsx", "scripts/build-personal-runtime.ts");
  await desktop("build:passwords-broker");
  await desktop("package:mac");
}
await writeFile(
  path.join(out, "build-inputs.json"),
  JSON.stringify(
    {
      sourceRevision: sha,
      version,
      unsigned,
      supervisorSha256: await hash(supervisor),
      cloudflaredSha256: await hash(cloudflared),
    },
    null,
    2,
  ) + "\n",
);
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `Built macOS arm64 ${version} from ${sha}.\n`);
