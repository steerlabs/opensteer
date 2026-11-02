import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  AppPublishInputSchema,
  OpensteerError,
  appMaxBytes,
  type AgentEvent,
  type UserId,
} from "@opensteer/core";
import type { AppStore, OpensteerStore } from "@opensteer/database";
import { createPrivateFileAtomically } from "@opensteer/shared/atomicPrivateFile";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import { prepareAppHtml, type AppTheme } from "@opensteer/shared/appFrame";
import type { AgentControlTokenService } from "../agents/agent-control-service.js";
import type { WorkspaceFilesService } from "../workspace/files/workspace-files-service.js";
import type { z } from "zod";

const unavailable = () =>
  new OpensteerError({ code: "not_found", message: "App content is unavailable" });
interface AppServiceOptions {
  readonly dataDirectory: string;
  readonly apps: AppStore;
  readonly store: Pick<OpensteerStore, "admitWorkspaceFiles">;
  readonly files: Pick<WorkspaceFilesService, "list" | "download">;
  readonly tokens: Pick<AgentControlTokenService, "authenticate" | "reauthorize">;
  readonly publishEvent: (event: AgentEvent) => void;
}

const tokenLifetimeMs = 5 * 60 * 1_000;
export class AppService {
  readonly #views = new Map<string, { appId: string; userId: UserId; expiresAt: number }>();
  readonly #directory: string;
  readonly #options: AppServiceOptions;
  constructor(options: AppServiceOptions) {
    this.#options = options;
    this.#directory = join(options.dataDirectory, "apps");
  }

  async publish(token: string, publishKey: string, input: z.infer<typeof AppPublishInputSchema>) {
    input = AppPublishInputSchema.parse(input);
    const scope = await this.#options.tokens.authenticate(token);
    const admission = await this.#options.store.admitWorkspaceFiles(
      scope.workspaceId,
      scope.requestedBy,
    );
    if (!admission) throw unavailable();
    if (input.appId) {
      const app = await this.get(input.appId, scope.requestedBy);
      if (app.workspaceId !== scope.workspaceId) throw unavailable();
    }
    // Files drivers resolve these opaque path segments against the identity-bound Workspace root.
    const segments = input.path.replace(/^\.\//u, "").split("/");
    if (
      segments.some(
        (part) =>
          !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"),
      )
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "Use an HTML file path relative to this Run's Workspace",
      });
    const signal = AbortSignal.timeout(30_000);
    let key = "";
    for (const [index, name] of segments.entries()) {
      let cursor: string | undefined;
      let found = false;
      do {
        const page = await this.#options.files.list(
          admission,
          { parentKey: key, limit: 500, ...(cursor ? { cursor } : {}) },
          signal,
        );
        const entry = page.entries.find((entry) => entry.name === name);
        if (entry) {
          if (entry.kind !== (index === segments.length - 1 ? "file" : "directory"))
            throw unavailable();
          key = entry.key;
          found = true;
          break;
        }
        cursor = page.cursor ?? undefined;
      } while (cursor);
      if (!found) throw unavailable();
    }
    const response = await this.#options.files.download(admission, key, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable();
    }
    const bytes = await readBoundedResponse(response, {
      maximumBytes: appMaxBytes,
      signal,
      sizeError: () =>
        new OpensteerError({ code: "bad_request", message: "App HTML exceeds the 5 MiB limit" }),
    });
    if (!bytes.byteLength)
      throw new OpensteerError({ code: "bad_request", message: "App HTML is empty" });
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new OpensteerError({ code: "bad_request", message: "App HTML must be UTF-8" });
    }
    if (
      !/\.html?$/iu.test(input.path) ||
      !/^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html(?:\s[^>]*)?>|<html(?:\s[^>]*)?>)/iu.test(
        html,
      )
    )
      throw new OpensteerError({
        code: "bad_request",
        message: "Publish a complete HTML document (.html or .htm)",
      });
    await this.#options.tokens.reauthorize(scope);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // A digest names complete immutable bytes; interrupted writes cannot replace another version.
    const file = join(this.#directory, sha256);
    await createPrivateFileAtomically(file, Buffer.from(bytes).toString("utf8"));
    const result = await this.#options.apps.publish({
      ...(input.appId ? { appId: input.appId } : {}),
      title: input.title,
      sha256,
      sizeBytes: bytes.byteLength,
      publishKey,
      workspaceId: scope.workspaceId,
      threadId: scope.threadId,
      runId: scope.runId,
      environmentId: scope.environmentId,
      userId: scope.requestedBy,
    });
    if (result.event) this.#options.publishEvent(result.event);
    return {
      appId: result.appId,
      version: result.version,
      message:
        "The app is already shown inline to the person. Do not restate its contents in your reply.",
    };
  }

  async collectGarbage(): Promise<void> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const referenced = new Set(await this.#options.apps.referencedDigests());
    for (const name of await readdir(this.#directory)) {
      if (/^[0-9a-f]{64}$/u.test(name) && !referenced.has(name))
        await rm(join(this.#directory, name), { force: true });
    }
  }

  get(appId: string, userId: UserId) {
    return this.#options.apps.get(appId, userId);
  }

  async view(appId: string, userId: UserId, theme: AppTheme) {
    const app = await this.get(appId, userId);
    const now = Date.now();
    for (const [token, view] of this.#views) if (view.expiresAt <= now) this.#views.delete(token);
    if (this.#views.size >= 2_048) this.#views.delete(this.#views.keys().next().value!);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + tokenLifetimeMs;
    this.#views.set(token, { appId, userId, expiresAt });
    return {
      app,
      path: `/v1/apps/${appId}/content?token=${token}&theme=${theme}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async content(appId: string, token: string, theme: AppTheme): Promise<string> {
    const view = this.#views.get(token);
    if (!view || view.appId !== appId || view.expiresAt <= Date.now()) throw unavailable();
    const { version } = await this.#options.apps.latest(appId, view.userId);
    const file = join(this.#directory, version.sha256);
    if ((await stat(file)).size !== version.sizeBytes) throw unavailable();
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== version.sha256) throw unavailable();
    return prepareAppHtml(new TextDecoder("utf-8", { fatal: true }).decode(bytes), theme);
  }
}
