import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stampReleaseVersion } from "./release-version.cjs";
import { replacePrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { z } from "zod";
import {
  agentPhoneSigningConfigSchema,
  buildAgentPhoneRelease,
  preflightAgentPhone,
} from "./release-agent-phone.js";
import {
  installLocalMac,
  localMacConfigSchema,
  preflightLocalMac,
  prepareLocalMac,
  verifyLocalMac,
  type MacContext,
} from "./release-beta-mac.js";
import {
  acquireReleaseLock,
  runBounded,
  timedCommands,
  type CommandOptions,
} from "./command-runner.js";

const absolutePath = z
  .string()
  .refine(
    (value) =>
      path.isAbsolute(value) &&
      path.resolve(value) === value &&
      value !== "/" &&
      !/[\r\n\0]/u.test(value),
    "Use a normalized absolute, non-root path",
  );
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const localInstallConfigSchema = z.strictObject({
  stateDirectory: absolutePath,
  agentPhone: agentPhoneSigningConfigSchema,
  runtimeInputs: z.strictObject({ postgres: absolutePath, node: absolutePath }),
  mac: localMacConfigSchema,
});
const localReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: z.literal("local-testing-only"),
  sourceRevision: sha,
  version: z.string(),
  configDigest: digest,
  phoneBuildStarted: z.boolean().default(false),
  phoneReceiptSha256: digest.optional(),
  verified: z.boolean().default(false),
});

export async function main(
  args = process.argv.slice(2),
  run: MacContext["run"] = runBounded,
  root = path.resolve(fileURLToPath(new URL("..", import.meta.url))),
) {
  const { values } = parseArgs({
    args,
    options: {
      config: { type: "string" },
      "source-sha": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    process.stdout.write(
      "pnpm desktop:install-local --source-sha FULL_COMMIT_SHA [--config /absolute/local.json]\nBuilds, signs, installs and launches this Mac's Beta app. Successful verification removes installer-owned old/prepared app copies. See docs/releases.md.\n",
    );
    return;
  }
  const revision = sha.parse(values["source-sha"]);
  const config = localInstallConfigSchema.parse(
    JSON.parse(
      await readFile(
        path.resolve(
          values.config ?? path.join(homedir(), ".config/opensteer/install-beta-mac-local.json"),
        ),
        "utf8",
      ),
    ),
  );
  const relative = path.relative(root, config.stateDirectory);
  if (!relative.startsWith(".." + path.sep) && !path.isAbsolute(relative))
    throw new Error("Local install state and snapshots must stay outside the checkout");
  const directory = path.join(config.stateDirectory, revision);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const unlock = await acquireReleaseLock(path.join(directory, "install.lock"));
  // Serialize all local installer revisions sharing this application, too.
  const appLock = `${config.mac.targets[0].applicationPath}.install.lock`;
  let unlockApp: (() => Promise<void>) | undefined;
  const stop = new AbortController();
  const interrupt = () =>
    stop.abort(
      new Error(
        "Local installation interrupted; retain receipts and rerun the same command to resume",
      ),
    );
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    unlockApp = await acquireReleaseLock(appLock);
    const timed = timedCommands(
      path.join(directory, "commands.jsonl"),
      (executable, argv, options = {}) => run(executable, argv, options),
    );
    const command = (executable: string, argv: readonly string[], options: CommandOptions = {}) =>
      timed(executable, argv, {
        cwd: root,
        signal: stop.signal,
        ...options,
        env: {
          ...options.env,
          OPENSTEER_PERSONAL_RUNTIME_POSTGRES_SOURCE: config.runtimeInputs.postgres,
          OPENSTEER_PERSONAL_RUNTIME_NODE_SOURCE: config.runtimeInputs.node,
        },
      });
    const git = (argv: readonly string[], cwd = root) => command("git", argv, { cwd });
    if (await git(["status", "--porcelain"]))
      throw new Error("Source checkout must be clean before local installation");
    if ((await git(["rev-parse", "--verify", `${revision}^{commit}`])) !== revision)
      throw new Error("Requested source SHA does not identify a local commit");
    const snapshot = path.join(directory, "source");
    try {
      await lstat(snapshot);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      await git(["worktree", "add", "--detach", snapshot, revision]);
    }
    const version = stampReleaseVersion(snapshot, revision);
    const configDigest = createHash("sha256").update(JSON.stringify(config)).digest("hex");
    const receiptPath = path.join(directory, "local-install.json");
    let state = localReceiptSchema.parse({
      schemaVersion: 1,
      purpose: "local-testing-only",
      sourceRevision: revision,
      version,
      configDigest,
    });
    try {
      state = localReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (
      state.sourceRevision !== revision ||
      state.version !== version ||
      state.configDigest !== configDigest
    )
      throw new Error(
        "Local receipt belongs to different source or configuration; retain it and use another stateDirectory",
      );
    const save = () =>
      replacePrivateFileAtomically(receiptPath, JSON.stringify(state, null, 2) + "\n");
    await save();
    process.stdout.write(`Local-only receipt: ${receiptPath}\n`);
    const context: MacContext = {
      heldApplicationLock: appLock,
      sourceDirectory: snapshot,
      stateDirectory: directory,
      identity: { sourceRevision: revision, version },
      signal: stop.signal,
      run: command,
      runtimeInputs: config.runtimeInputs,
      agentPhoneSigning: config.agentPhone,
      agentPhoneArtifactDirectory: path.join(directory, "agent-phone"),
    };
    await preflightLocalMac(config.mac, context);
    const phone = {
      sourceDirectory: snapshot,
      artifactDirectory: path.join(directory, "agent-phone"),
      identity: context.identity,
      signal: stop.signal,
      run: command,
    };
    await preflightAgentPhone(config.agentPhone, phone);
    await command("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], {
      cwd: snapshot,
      timeoutMs: 300_000,
    });
    if (!state.phoneReceiptSha256 && state.phoneBuildStarted)
      throw new Error(
        "Interrupted Agent Phone build has no trusted receipt. Reconcile retained artifacts before another build; no automatic rebuild was attempted",
      );
    const buildContext: MacContext = {
      ...context,
      agentPhoneReceiptSha256: state.phoneReceiptSha256,
      prepareAgentPhone: async (signal) => {
        if (!state.phoneReceiptSha256) {
          state.phoneBuildStarted = true;
          await save();
          state.phoneReceiptSha256 = await buildAgentPhoneRelease(config.agentPhone, {
            ...phone,
            signal,
          });
          await save();
        }
        return state.phoneReceiptSha256;
      },
    };
    await prepareLocalMac(config.mac, buildContext);
    await installLocalMac(config.mac, buildContext);
    await verifyLocalMac(config.mac, buildContext);
    state.verified = true;
    await save();
    await replacePrivateFileAtomically(
      path.join(directory, "journey.json"),
      JSON.stringify(
        {
          sourceRevision: revision,
          application: config.mac.targets[0].applicationPath,
          signedBundle: true,
          launched: true,
          supervisorAndHostHealthy: true,
          authenticatedUiAndAgentTurn:
            "Requires a real installed-app journey; process/HTTP health does not verify this",
          verifiedAt: new Date().toISOString(),
          receipt: receiptPath,
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write(
      `Signed local install and process/HTTP health verified. Authenticated UI/agent smoke remains required. Evidence: ${directory}\n`,
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await unlockApp?.();
    await unlock();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
