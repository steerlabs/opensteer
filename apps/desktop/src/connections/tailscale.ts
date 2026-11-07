import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import type { PrivateFilesystem } from "@opensteer/client/connections";
import {
  DesktopTailscaleShareResultSchema,
  DesktopTailscaleStatusSchema,
  type DesktopTailscaleShareResult,
  type DesktopTailscaleStatus,
} from "@opensteer/protocol/desktop";
import { z } from "zod";

const macAppExecutable = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const commandTimeoutMs = 5_000;
const maximumRecordBytes = 4_096;
/** Ports Tailscale serves HTTPS on without extra setup; Opensteer takes the first one free. */
const httpsPorts = [443, 8443] as const;
type HttpsPort = (typeof httpsPorts)[number];

export interface TailscaleCommandOutput {
  readonly stderr: string;
  readonly stdout: string;
}

/** A command that ran and failed; `missing` when there was no such program. */
export class TailscaleCommandError extends Error {
  readonly missing: boolean;
  readonly output: TailscaleCommandOutput;

  constructor(output: TailscaleCommandOutput, missing: boolean) {
    super(missing ? "Tailscale is not installed." : "A Tailscale command failed.");
    this.missing = missing;
    this.output = output;
  }
}

export type TailscaleCommand = (
  executable: string,
  args: readonly string[],
) => Promise<TailscaleCommandOutput>;

/** Runs the person's own Tailscale command line: no shell, a deadline, bounded output. */
export function tailscaleCommand(
  environment: () => Promise<Readonly<Record<string, string | undefined>>>,
): TailscaleCommand {
  return async (executable, args) => {
    const env = await environment();
    return new Promise((resolvePromise, reject) => {
      execFile(
        executable,
        [...args],
        { encoding: "utf8", env, maxBuffer: 1024 * 1024, timeout: commandTimeoutMs },
        (error, stdout, stderr) => {
          if (!error) resolvePromise({ stderr, stdout });
          else reject(new TailscaleCommandError({ stderr, stdout }, error.code === "ENOENT"));
        },
      );
    });
  };
}

const LoopbackTargetSchema = z.string().regex(/^http:\/\/127\.0\.0\.1:\d{1,5}$/u);

/**
 * The one handler Opensteer added to this computer's Tailscale serve config.
 * While it is being re-pointed, `previousTarget` names where it pointed
 * before, so a change that applied but never answered — or a crash in the
 * middle — still leaves a handler the record recognises.
 */
const ShareRecordSchema = z.strictObject({
  origin: z.url({ protocol: /^https$/u }).max(512),
  port: z.union([z.literal(443), z.literal(8443)]),
  previousTarget: LoopbackTargetSchema.optional(),
  schemaVersion: z.literal(1),
  target: LoopbackTargetSchema,
});
type ShareRecord = z.infer<typeof ShareRecordSchema>;

/** Whether the port still serves the handler the record names, at either target. */
function ownsHandler(config: TailscaleServeConfig, record: ShareRecord): boolean {
  return (
    servesOnly(config, record.port, record.target) ||
    (record.previousTarget !== undefined && servesOnly(config, record.port, record.previousTarget))
  );
}

const StatusSchema = z.looseObject({
  BackendState: z.string().optional(),
  Self: z.looseObject({ DNSName: z.string().optional() }).nullish(),
});

const WebSchema = z.record(
  z.string(),
  z.looseObject({
    Handlers: z
      .record(z.string(), z.looseObject({ Proxy: z.string().optional() }).nullable())
      .nullish(),
  }),
);
const serveConfigShape = {
  AllowFunnel: z.record(z.string(), z.boolean()).nullish(),
  TCP: z.record(z.string(), z.unknown()).nullish(),
  Web: WebSchema.nullish(),
};
const ServeConfigSchema = z.looseObject({
  ...serveConfigShape,
  Foreground: z.record(z.string(), z.looseObject(serveConfigShape)).nullish(),
});
export type TailscaleServeConfig = z.infer<typeof ServeConfigSchema>;

/** This computer's tailnet state as its `status --json` reports it. */
export function parseTailscaleStatus(
  stdout: string,
): { readonly state: "ready"; readonly dnsName: string } | { readonly state: "not-running" } {
  const parsed = StatusSchema.safeParse(parseJson(stdout));
  const dnsName = parsed.data?.Self?.DNSName?.trim().replace(/\.$/u, "").toLowerCase() ?? "";
  // HTTPS names exist only with MagicDNS; without one there is nothing to share at.
  if (parsed.data?.BackendState !== "Running" || !dnsName) return { state: "not-running" };
  return { dnsName, state: "ready" };
}

export function parseServeConfig(stdout: string): TailscaleServeConfig {
  const trimmed = stdout.trim();
  if (!trimmed) return {};
  // A schema error would name the person's own hosts and paths; this says only what failed.
  const parsed = ServeConfigSchema.safeParse(parseJson(trimmed));
  if (!parsed.success) throw new Error("Tailscale's serve settings could not be read.");
  return parsed.data;
}

/** Every port something (serve or Funnel, background or foreground) already listens on. */
export function usedServePorts(config: TailscaleServeConfig): ReadonlySet<number> {
  const used = new Set<number>();
  const collect = (part: z.infer<z.ZodObject<typeof serveConfigShape>>) => {
    for (const key of Object.keys(part.TCP ?? {})) used.add(Number(key));
    for (const key of [...Object.keys(part.Web ?? {}), ...Object.keys(part.AllowFunnel ?? {})]) {
      used.add(Number(key.slice(key.lastIndexOf(":") + 1)));
    }
  };
  collect(config);
  for (const foreground of Object.values(config.Foreground ?? {})) collect(foreground);
  return used;
}

/**
 * True when the port serves exactly one thing, `/` proxied to `target`, and is
 * not on Funnel: the handler Opensteer adds, unchanged by anyone since.
 */
export function servesOnly(config: TailscaleServeConfig, port: number, target: string): boolean {
  const entries = Object.entries(config.Web ?? {}).filter(([key]) => key.endsWith(`:${port}`));
  if (entries.length !== 1) return false;
  const [key, web] = entries[0]!;
  const handlers = Object.entries(web.Handlers ?? {});
  return (
    handlers.length === 1 &&
    handlers[0]![0] === "/" &&
    handlers[0]![1]?.Proxy === target &&
    config.AllowFunnel?.[key] !== true
  );
}

/** Opensteer's own port when its handler is still there, else the first one free. */
export function chooseHttpsPort(
  config: TailscaleServeConfig,
  record: ShareRecord | null,
): HttpsPort | null {
  if (record && ownsHandler(config, record)) return record.port;
  const used = usedServePorts(config);
  return httpsPorts.find((port) => !used.has(port)) ?? null;
}

/** A failed `tailscale serve`, in the words the person needs to fix it. */
export function shareFailure(
  output: TailscaleCommandOutput,
): Extract<DesktopTailscaleShareResult, { readonly ok: false }> {
  const text = `${output.stdout}\n${output.stderr}`;
  if (/not logged in|logged out|needs ?login|is stopped|tailscaled|local tailscale/iu.test(text)) {
    return failure("not-running", "Open Tailscale and sign in, then try again.");
  }
  if (
    /serve is not enabled|https.{0,40}(not enabled|disabled)|enable https|certificates?.{0,40}(not enabled|disabled)/iu.test(
      text,
    )
  ) {
    return failure(
      "https-disabled",
      "Turn on HTTPS certificates in your Tailscale admin console, then try again.",
    );
  }
  if (/access denied|permission denied|operator/iu.test(text)) {
    return failure(
      "failed",
      "Tailscale refused. Let your user manage it with “sudo tailscale set --operator=$USER”, then try again.",
    );
  }
  return failure(
    "failed",
    "Tailscale couldn't share Opensteer. Check that Tailscale is up to date, then try again.",
  );
}

/**
 * How long a handler shared for setup waits for the Host to take its route.
 * The page gives up after two minutes; the margin keeps a slow but successful
 * hand-off from being taken down under it.
 */
export const tailscaleHandoffMilliseconds = 3 * 60_000;

export interface TailscaleShareOptions {
  readonly command: TailscaleCommand;
  readonly now?: () => number;
  /** Where the record of Opensteer's own handler lives, in this app's data directory. */
  readonly recordPath: string;
  readonly files: Pick<PrivateFilesystem, "readFile" | "removeFile" | "writeFileAtomic">;
  readonly platform?: NodeJS.Platform;
  readonly executableExists?: (path: string) => Promise<boolean>;
}

/**
 * Serves this computer's Personal Host over HTTPS on the person's tailnet with
 * `tailscale serve`, never Funnel. Opensteer records exactly the handler it
 * created and only ever re-points or removes a handler that still matches
 * that record; anything else in the person's serve config is theirs.
 */
export class TailscaleShare {
  readonly #command: TailscaleCommand;
  readonly #executableExists: (path: string) => Promise<boolean>;
  readonly #files: TailscaleShareOptions["files"];
  readonly #platform: NodeJS.Platform;
  readonly #recordPath: string;
  /**
   * The origin shared in this run whose Private route the Host has not taken
   * yet. The page asks the Host for that route only after `share` answers, so
   * a reconcile in between must leave the handler it is about to use — but
   * only for a while: a page that gave up never asks, and the next reconcile
   * after `until` takes the handler down.
   */
  #sharedThisRun: { readonly origin: string; readonly until: number } | null = null;
  readonly #now: () => number;

  constructor(options: TailscaleShareOptions) {
    this.#command = options.command;
    this.#executableExists =
      options.executableExists ??
      ((path) =>
        access(path, constants.X_OK).then(
          () => true,
          () => false,
        ));
    this.#files = options.files;
    this.#now = options.now ?? Date.now;
    this.#platform = options.platform ?? process.platform;
    this.#recordPath = options.recordPath;
  }

  async status(): Promise<DesktopTailscaleStatus> {
    const tailnet = await this.#tailnet();
    if (tailnet.state !== "ready") return DesktopTailscaleStatusSchema.parse(tailnet);
    const record = await this.#readRecord();
    let sharedOrigin: string | null = null;
    if (record && sameOrigin(record.origin, originFor(tailnet.dnsName, record.port))) {
      const config = await this.#serveConfig(tailnet.executable).catch(() => null);
      if (config && ownsHandler(config, record)) sharedOrigin = record.origin;
    }
    return DesktopTailscaleStatusSchema.parse({
      dnsName: tailnet.dnsName,
      sharedOrigin,
      state: "ready",
    });
  }

  /** Points an HTTPS port on the tailnet at `hostOrigin`, the Host's loopback address. */
  async share(hostOrigin: string): Promise<DesktopTailscaleShareResult> {
    const target = loopbackTarget(hostOrigin);
    const tailnet = await this.#tailnet();
    if (tailnet.state === "not-installed") {
      return failure("not-installed", "Install Tailscale on this computer, then try again.");
    }
    if (tailnet.state === "not-running") {
      return failure("not-running", "Open Tailscale and sign in, then try again.");
    }
    let config: TailscaleServeConfig;
    try {
      config = await this.#serveConfig(tailnet.executable);
    } catch (error) {
      return error instanceof TailscaleCommandError
        ? shareFailure(error.output)
        : failure("failed", "Tailscale's serve settings couldn't be read. Try again.");
    }
    const previous = await this.#readRecord();
    const port = chooseHttpsPort(config, previous);
    if (port === null) {
      return failure(
        "ports-busy",
        "Tailscale is already serving something else on ports 443 and 8443 on this computer.",
      );
    }
    const record: ShareRecord = {
      origin: originFor(tailnet.dnsName, port),
      port,
      schemaVersion: 1,
      target,
    };
    // Persist both possible owned targets before the CLI can apply the change.
    const ours = previous !== null && ownsHandler(config, previous);
    const pointedAt = !ours
      ? undefined
      : servesOnly(config, previous.port, previous.target)
        ? previous.target
        : previous.previousTarget;
    await this.#writeRecord(
      pointedAt && pointedAt !== target ? { ...record, previousTarget: pointedAt } : record,
    );
    try {
      await this.#serve(tailnet.executable, port, target);
    } catch (error) {
      // A command that timed out or lost its answer may still have applied,
      // so the record goes only once the handler is seen not to exist.
      if (!ours) {
        const after = await this.#serveConfig(tailnet.executable).catch(() => null);
        if (after && !servesOnly(after, port, target)) await this.#removeRecord();
      }
      return error instanceof TailscaleCommandError
        ? shareFailure(error.output)
        : failure("failed", "Tailscale couldn't share Opensteer. Try again.");
    }
    await this.#writeRecord(record);
    this.#sharedThisRun = {
      origin: record.origin,
      until: this.#now() + tailscaleHandoffMilliseconds,
    };
    return DesktopTailscaleShareResultSchema.parse({ ok: true, origin: record.origin });
  }

  /**
   * Makes the serve config agree with the Host's route: Opensteer's handler
   * exists, aimed at the Host's current port, exactly while the Host's Private
   * route is the origin it was made for. `routeOrigin` is that route as the
   * Host reports it now; `authoritative` is true after someone chose a mode.
   */
  async reconcile(input: {
    readonly authoritative: boolean;
    readonly hostOrigin: string;
    readonly routeOrigin: string | null;
  }): Promise<void> {
    const record = await this.#readRecord();
    if (!record) return;
    if (input.routeOrigin !== null && sameOrigin(input.routeOrigin, record.origin)) {
      this.#sharedThisRun = null;
      await this.#ensure(record, loopbackTarget(input.hostOrigin));
      return;
    }
    const handoff = this.#sharedThisRun;
    if (!input.authoritative && handoff?.origin === record.origin && this.#now() < handoff.until) {
      return;
    }
    this.#sharedThisRun = null;
    const tailnet = await this.#tailnet();
    // The record stays until its handler can be seen to be gone.
    if (tailnet.state !== "ready") return;
    const config = await this.#serveConfig(tailnet.executable);
    if (ownsHandler(config, record)) {
      await this.#command(tailnet.executable, ["serve", `--https=${record.port}`, "off"]);
    }
    await this.#removeRecord();
  }

  /** Takes Opensteer's handler down while the Host is gone, keeping the record to restore it. */
  async stop(): Promise<void> {
    const record = await this.#readRecord();
    if (!record) return;
    const tailnet = await this.#tailnet();
    if (tailnet.state !== "ready") return;
    const config = await this.#serveConfig(tailnet.executable);
    if (ownsHandler(config, record)) {
      await this.#command(tailnet.executable, ["serve", `--https=${record.port}`, "off"]);
    }
  }

  async #ensure(record: ShareRecord, target: string): Promise<void> {
    const tailnet = await this.#tailnet();
    if (tailnet.state !== "ready") return;
    const config = await this.#serveConfig(tailnet.executable);
    const settled: ShareRecord = {
      origin: record.origin,
      port: record.port,
      schemaVersion: 1,
      target,
    };
    const ours = ownsHandler(config, record);
    // A matching destination alone does not make a foreign handler ours.
    if (!ours && usedServePorts(config).has(record.port)) return;
    if (servesOnly(config, record.port, target)) {
      if (record.target !== target || record.previousTarget) await this.#writeRecord(settled);
      return;
    }
    // Recorded before the change, with where it pointed until now.
    const pointedAt = servesOnly(config, record.port, record.target)
      ? record.target
      : record.previousTarget;
    await this.#writeRecord(
      ours && pointedAt && pointedAt !== target
        ? { ...settled, previousTarget: pointedAt }
        : settled,
    );
    await this.#serve(tailnet.executable, record.port, target);
    await this.#writeRecord(settled);
  }

  async #tailnet(): Promise<
    | { readonly state: "not-installed" }
    | { readonly state: "not-running" }
    | { readonly dnsName: string; readonly executable: string; readonly state: "ready" }
  > {
    const executable = await this.#executable();
    if (!executable) return { state: "not-installed" };
    try {
      const { stdout } = await this.#command(executable, ["status", "--json"]);
      const status = parseTailscaleStatus(stdout);
      return status.state === "ready" ? { ...status, executable } : status;
    } catch (error) {
      if (error instanceof TailscaleCommandError && error.missing)
        return { state: "not-installed" };
      return { state: "not-running" };
    }
  }

  /** The Mac app's bundled command line first, then `tailscale` on the person's PATH. */
  async #executable(): Promise<string | null> {
    if (this.#platform === "darwin" && (await this.#executableExists(macAppExecutable))) {
      return macAppExecutable;
    }
    return this.#platform === "darwin" || this.#platform === "linux" ? "tailscale" : null;
  }

  async #serveConfig(executable: string): Promise<TailscaleServeConfig> {
    const { stdout } = await this.#command(executable, ["serve", "status", "--json"]);
    return parseServeConfig(stdout);
  }

  async #serve(executable: string, port: HttpsPort, target: string): Promise<void> {
    await this.#command(executable, ["serve", "--bg", `--https=${port}`, target]);
  }

  async #readRecord(): Promise<ShareRecord | null> {
    const bytes = await this.#files.readFile(this.#recordPath, maximumRecordBytes);
    if (!bytes) return null;
    const parsed = ShareRecordSchema.safeParse(parseJson(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : null;
  }

  async #writeRecord(record: ShareRecord): Promise<void> {
    await this.#files.writeFileAtomic(
      this.#recordPath,
      `${JSON.stringify(ShareRecordSchema.parse(record))}\n`,
    );
  }

  async #removeRecord(): Promise<void> {
    await this.#files.removeFile(this.#recordPath);
  }
}

function failure(
  reason: Extract<DesktopTailscaleShareResult, { readonly ok: false }>["reason"],
  message: string,
): Extract<DesktopTailscaleShareResult, { readonly ok: false }> {
  return { message, ok: false, reason };
}

function originFor(dnsName: string, port: HttpsPort): string {
  return port === 443 ? `https://${dnsName}` : `https://${dnsName}:${port}`;
}

/** The Host binds 127.0.0.1 alone, whichever loopback name its origin uses. */
function loopbackTarget(hostOrigin: string): string {
  const port = new URL(hostOrigin).port;
  if (!port) throw new Error("The Personal Host has no loopback port to share.");
  return `http://127.0.0.1:${port}`;
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
