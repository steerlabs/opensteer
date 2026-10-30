import { randomBytes } from "node:crypto";
import { z } from "zod";
import { ExecutionContextInventory, type ExecutionContextEntry } from "@opensteer/browser-core";
import { withTimeout } from "@opensteer/shared/withTimeout";
import { encodeBase64Url } from "@opensteer/shared/base64url";
import {
  PublicKeyCredentialCreationOptionsJSONSchema,
  PublicKeyCredentialRequestOptionsJSONSchema,
  buildAuthenticationResponseJSON,
  buildRegistrationResponseJSON,
  resolveRpId,
  serializeClientData,
  type PasskeyAuthenticator,
} from "../passkeys/index.js";
import type { BrowserPagePolicyConfig } from "./page-policy.js";
import type { CdpSession } from "./backend.js";

export function createPasskeyProviderConfig(): NonNullable<BrowserPagePolicyConfig> {
  return {
    bindingName: `opensteerPasskey_${randomBytes(32).toString("hex")}`,
    replyName: `opensteerReply_${randomBytes(32).toString("hex")}`,
  };
}
const bindingEvent = z.object({
  name: z.string(),
  executionContextId: z.number().int(),
  payload: z.string().max(262_144),
});
const token = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\w-]+$/u);
const request = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["create", "get"]), id: token, options: z.unknown() }),
  z.object({ op: z.literal("cancel"), id: token }),
]);
interface FrameTree {
  frame: { id: string; url: string; securityOrigin: string };
  childFrames?: FrameTree[] | undefined;
}
const frameTree: z.ZodType<FrameTree> = z.object({
  frame: z.object({ id: z.string(), url: z.string(), securityOrigin: z.string() }),
  childFrames: z.lazy(() => z.array(frameTree)).optional(),
});
const committedFrame = z.object({
  frame: z.object({
    id: z.string(),
    loaderId: z.string().min(1),
    url: z.string(),
    securityOrigin: z.string(),
    parentId: z.string().optional(),
  }),
});
type CommittedFrame = z.infer<typeof committedFrame>["frame"];
const documentResponse = z.object({
  type: z.literal("Document"),
  frameId: z.string(),
  loaderId: z.string(),
  response: z.unknown(),
});
const trustedResponse = z.object({
  url: z.url(),
  securityState: z.literal("secure"),
  securityDetails: z.object({ protocol: z.string().min(1) }),
});
const visibleSecurity = z.object({
  visibleSecurityState: z.object({
    securityState: z.enum(["unknown", "neutral", "insecure", "secure", "info", "insecure-broken"]),
    certificateSecurityState: z
      .object({ certificateNetworkError: z.string().optional() })
      .optional(),
  }),
});
const bootstrapSecurity = z.object({
  visibleSecurityState: z.object({
    securityState: z.literal("secure"),
    certificateSecurityState: z.object({
      protocol: z.string().min(1),
      certificate: z.array(z.string().min(1)).min(1),
      certificateNetworkError: z.string().optional(),
    }),
  }),
});
const navigationHistory = z.object({
  currentIndex: z.number().int().nonnegative(),
  entries: z.array(z.object({ id: z.number().int(), url: z.string() })),
});
interface BootstrapIdentity {
  frame: CommittedFrame;
  entryId: number;
  context: ExecutionContextEntry;
}
const policyState = z.object({
  states: z.array(z.object({ feature: z.string(), allowed: z.boolean() })),
});
const errorMessages = {
  NotAllowedError: "The passkey request is not allowed.",
  InvalidStateError: "The credential is already registered.",
  NotSupportedError: "The passkey request is not supported.",
  SecurityError: "The relying party ID is not allowed for this origin.",
  AbortError: "The passkey request was aborted.",
  ConstraintError: "The authenticator cannot satisfy the request.",
  UnknownError: "The passkey request failed.",
  OperationError: "A request is already pending.",
  TypeError: "Invalid public key credential options.",
} as const;
type PageError = keyof typeof errorMessages;
class Refusal extends Error {
  readonly error: PageError;
  constructor(error: PageError) {
    super(errorMessages[error]);
    this.error = error;
  }
}

/** One tab's client checks and cancellation, on its existing platform CDP session. */
export class PasskeyBridge {
  readonly config: NonNullable<BrowserPagePolicyConfig>;
  get bindingName(): string {
    return this.config.bindingName;
  }
  readonly #targetId: (() => Promise<string>) | undefined;
  readonly #cdp: CdpSession;
  readonly #authenticator: PasskeyAuthenticator;
  readonly #contexts: Pick<ExecutionContextInventory, "entries">;
  readonly #ownedContexts: ExecutionContextInventory | undefined;
  readonly #listeners = new Map<string, (event: unknown) => void>();
  readonly #commits = new Map<string, CommittedFrame>();
  readonly #documents = new WeakMap<
    ExecutionContextEntry,
    { frame: CommittedFrame; top: CommittedFrame } | null
  >();
  readonly #tls = new Map<string, { frameId: string; origin: string | null; trusted: boolean }>();
  #top: CommittedFrame | null = null;
  #security: { document: CommittedFrame; refused: boolean } | null = null;
  #pending: { id: string; context: ExecutionContextEntry; controller: AbortController } | null =
    null;
  readonly #lateBootstrap: boolean;
  #generation = 0;
  #bootstrapDocument: { frame: CommittedFrame; uniqueId: string } | null = null;
  #sample: { generation: number; state: unknown } | undefined;
  #closed = false;
  #start: Promise<void> | undefined;

  constructor(
    cdp: CdpSession,
    authenticator: PasskeyAuthenticator,
    options: {
      targetId?: () => Promise<string>;
      config?: NonNullable<BrowserPagePolicyConfig>;
      lateBootstrap?: boolean | undefined;
      /** Electron supplies its hub's inventory; only standalone sessions keep their own. */
      contexts?: Pick<ExecutionContextInventory, "entries">;
    } = {},
  ) {
    this.#cdp = cdp;
    this.#lateBootstrap = options.lateBootstrap === true;
    this.#targetId = options.targetId;
    this.#authenticator = authenticator;
    this.config = options.config ?? createPasskeyProviderConfig();
    this.#ownedContexts = options.contexts ? undefined : new ExecutionContextInventory();
    this.#contexts = options.contexts ?? this.#ownedContexts!;
    // Existing contexts cannot be granted eligibility by a later Runtime replay.
    for (const context of this.#contexts.entries()) this.#documents.set(context, null);
    this.#listen("Page.frameNavigated", (value) => {
      this.#generation++;
      const event = committedFrame.safeParse(value);
      if (!event.success) return;
      const frame = event.data.frame;
      if (frame.parentId === undefined || this.#bootstrapDocument?.frame.id === frame.id)
        this.#bootstrapDocument = null;
      if (frame.parentId === undefined) {
        this.#top = frame;
        this.#commits.clear();
        this.#security = null;
      }
      this.#commits.set(frame.id, frame);
      // Chromium may retain the initial main world through its first
      // same-origin navigation. A real browser commit establishes the new
      // document even when no second context-created event is emitted.
      for (const context of this.#contexts.entries()) {
        if (
          context.mainWorld &&
          context.frameId === frame.id &&
          this.#top &&
          frame.url.startsWith("https:") &&
          frame.securityOrigin === context.description.origin
        )
          this.#documents.set(context, { frame, top: this.#top });
      }
      this.#abortIneligible();
    });
    this.#listen("Page.frameDetached", (value) => {
      this.#generation++;
      const event = z.object({ frameId: z.string() }).safeParse(value);
      if (event.success) this.#commits.delete(event.data.frameId);
      if (!event.success || this.#bootstrapDocument?.frame.id === event.data.frameId)
        this.#bootstrapDocument = null;
      this.#abortIneligible();
    });
    this.#listen("Network.responseReceived", (value) => {
      const event = documentResponse.safeParse(value);
      if (!event.success) return;
      const response = trustedResponse.safeParse(event.data.response);
      const origin =
        response.success && response.data.url.startsWith("https:")
          ? new URL(response.data.url).origin
          : null;
      this.#tls.set(event.data.loaderId, {
        frameId: event.data.frameId,
        origin,
        trusted: response.success && origin !== null,
      });
      // Keep only document responses, bounded independently of a tab's lifetime.
      // Committed documents keep their evidence however many other documents load.
      const committed = new Set([...this.#commits.values()].map((frame) => frame.loaderId));
      const evictable = [...this.#tls.keys()].filter((loaderId) => !committed.has(loaderId));
      for (const loaderId of evictable.slice(0, Math.max(0, evictable.length - 64)))
        this.#tls.delete(loaderId);
      this.#abortIneligible();
    });
    this.#listen("Security.visibleSecurityStateChanged", (value) => {
      if (this.#sample?.generation === this.#generation) this.#sample.state = value;
      if (!this.#top) return;
      const event = visibleSecurity.safeParse(value);
      this.#security = {
        document: this.#top,
        refused:
          !event.success ||
          event.data.visibleSecurityState.securityState === "insecure" ||
          event.data.visibleSecurityState.securityState === "insecure-broken" ||
          Boolean(
            event.data.visibleSecurityState.certificateSecurityState?.certificateNetworkError,
          ),
      };
      this.#abortIneligible();
    });
    for (const method of [
      "Runtime.executionContextCreated",
      "Runtime.executionContextDestroyed",
      "Runtime.executionContextsCleared",
    ]) {
      this.#listen(method, (value) => {
        this.#generation++;
        const parameters = z.record(z.string(), z.unknown()).safeParse(value);
        if (!parameters.success) return;
        // document.open() can reset worlds without a navigation. Only a
        // browser commit replaces the pinned document's frame identity.
        const observed = this.#ownedContexts?.observe(method, parameters.data);
        if (method === "Runtime.executionContextCreated") {
          const description = z
            .object({ context: z.object({ id: z.number(), uniqueId: z.string() }) })
            .safeParse(parameters.data);
          const context =
            observed ??
            (description.success
              ? this.#contexts
                  .entries()
                  .find(
                    (entry) =>
                      entry.id === description.data.context.id &&
                      entry.uniqueId === description.data.context.uniqueId,
                  )
              : undefined);
          if (context && !this.#documents.has(context)) {
            const frame = context.frameId ? this.#commits.get(context.frameId) : undefined;
            this.#documents.set(
              context,
              frame &&
                this.#top &&
                frame.url.startsWith("https:") &&
                frame.securityOrigin === context.description.origin
                ? { frame, top: this.#top }
                : null,
            );
          }
        }
        if (
          this.#bootstrapDocument &&
          !this.#sameBootstrapDocument(
            this.#bootstrapDocument.frame.id,
            this.#bootstrapDocument.frame.loaderId,
          )
        )
          this.#bootstrapDocument = null;
        this.#abortIneligible();
      });
    }
    for (const method of [
      "Page.frameStartedNavigating",
      "Page.frameRequestedNavigation",
      "Page.frameStartedLoading",
      "Page.navigatedWithinDocument",
      "Page.frameSubtreeWillBeDetached",
    ]) {
      this.#listen(method, (value) => {
        this.#generation++;
        if (
          method === "Page.frameStartedNavigating" ||
          method === "Page.frameSubtreeWillBeDetached"
        ) {
          const event = z.object({ frameId: z.string() }).safeParse(value);
          if (!event.success || this.#bootstrapDocument?.frame.id === event.data.frameId)
            this.#bootstrapDocument = null;
        }
        this.#abortIneligible();
      });
    }
    this.#listen("Page.documentOpened", (value) => {
      this.#generation++;
      const event = committedFrame.safeParse(value);
      const accepted = this.#bootstrapDocument;
      if (
        accepted &&
        (!event.success ||
          ((event.data.frame.parentId === undefined || event.data.frame.id === accepted.frame.id) &&
            (!this.#sameBootstrapDocument(event.data.frame.id, event.data.frame.loaderId) ||
              event.data.frame.securityOrigin !== accepted.frame.securityOrigin)))
      )
        this.#bootstrapDocument = null;
      this.#abortIneligible();
    });
    this.#listen("Page.lifecycleEvent", (value) => {
      const event = z
        .object({
          name: z.string(),
          frameId: z.string().optional(),
          loaderId: z.string().optional(),
        })
        .safeParse(value);
      if (!event.success || event.data.name !== "init") return;
      // init invalidates an unfinished sample, but document.open() also emits
      // it without replacing the frame, loader or main-world context.
      this.#generation++;
      if (
        this.#bootstrapDocument &&
        (!event.data.frameId ||
          (event.data.frameId === this.#bootstrapDocument.frame.id &&
            !this.#sameBootstrapDocument(event.data.frameId, event.data.loaderId)))
      )
        this.#bootstrapDocument = null;
      this.#abortIneligible();
    });
    this.#listen("Runtime.bindingCalled", (event) => {
      void this.#onBinding(event);
    });
    this.#listen("Inspector.detached", () => this.close());
    this.#listen("close", () => this.close());
  }

  /** Does not gate Electron's first navigation: a renderer must exist to answer it. */
  start(): Promise<void> {
    this.#start ??= (async () => {
      // Domain ownership remains with the page's platform session. Electron's
      // hub reference-counts these enables with its other consumers.
      const domains = ["Page", "Network", "Runtime"];
      if (!this.#lateBootstrap) domains.push("Security");
      await Promise.all(domains.map((domain) => this.#cdp.send(`${domain}.enable`)));
      if (this.#lateBootstrap) {
        await this.#cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
        await withTimeout(this.#bootstrap(), 1500, {
          timeoutError: () => new Error("Passkey document sampling timed out."),
        }).catch(() => {
          this.#generation++;
          this.#sample = undefined;
        });
      }
      if (!this.#closed) await this.#cdp.send("Runtime.addBinding", { name: this.bindingName });
    })();
    return this.#start;
  }

  async #identity(): Promise<BootstrapIdentity | null> {
    const tree = committedFrame.safeParse(
      (await this.#cdp.send<{ frameTree?: unknown }>("Page.getFrameTree")).frameTree,
    );
    const history = navigationHistory.safeParse(await this.#cdp.send("Page.getNavigationHistory"));
    if (!tree.success || !history.success || tree.data.frame.parentId !== undefined) return null;
    const frame = tree.data.frame;
    const entry = history.data.entries[history.data.currentIndex];
    const contexts = this.#contexts
      .entries()
      .filter((context) => context.frameId === frame.id && context.mainWorld);
    if (!entry || contexts.length !== 1) return null;
    return { frame, entryId: entry.id, context: contexts[0]! };
  }

  async #bootstrap(): Promise<void> {
    const generation = this.#generation;
    const before = await this.#identity();
    // This is the session's first enable. Events outside this exact sample
    // never become positive authority, and start() never retries the enable.
    const sample: { generation: number; state: unknown } = { generation, state: undefined };
    this.#sample = sample;
    try {
      await this.#cdp.send("Security.enable");
      const after = await this.#identity();
      const state = bootstrapSecurity.safeParse(sample.state);
      if (
        !before ||
        !after ||
        !state.success ||
        this.#closed ||
        generation !== this.#generation ||
        before.frame.id !== after.frame.id ||
        before.frame.loaderId !== after.frame.loaderId ||
        before.entryId !== after.entryId ||
        before.context.uniqueId !== after.context.uniqueId ||
        !after.context.uniqueId ||
        !this.#live(after.context) ||
        !after.frame.url.startsWith("https:") ||
        after.frame.securityOrigin !== after.context.description.origin ||
        typeof after.context.description.origin !== "string" ||
        !after.context.description.origin.startsWith("https:") ||
        state.data.visibleSecurityState.certificateSecurityState.certificateNetworkError
      )
        return;
      // This evidence is pinned to one top-level document and context, never
      // to a page-supplied origin or a later Security event.
      const frame = after.frame;
      this.#top = frame;
      this.#commits.set(frame.id, frame);
      this.#bootstrapDocument = { frame, uniqueId: after.context.uniqueId };
      this.#documents.set(after.context, { frame, top: frame });
      this.#security = { document: frame, refused: false };
    } finally {
      if (this.#sample === sample) this.#sample = undefined;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending?.controller.abort();
    for (const [event, listener] of this.#listeners) this.#cdp.off(event, listener);
    this.#listeners.clear();
    this.#ownedContexts?.clear();
    this.#commits.clear();
    this.#top = null;
    this.#security = null;
    this.#bootstrapDocument = null;
    void this.#cdp.send("Runtime.removeBinding", { name: this.bindingName }).catch(() => undefined);
  }

  #listen(event: string, listener: (value: unknown) => void): void {
    this.#listeners.set(event, listener);
    this.#cdp.on(event, listener);
  }
  #live(context: ExecutionContextEntry): boolean {
    return (
      !this.#closed &&
      this.#contexts
        .entries()
        .some((entry) => entry.uniqueId === context.uniqueId && entry.id === context.id)
    );
  }
  #sameBootstrapDocument(frameId: string, loaderId: string | undefined): boolean {
    const accepted = this.#bootstrapDocument;
    if (
      !accepted ||
      accepted.frame.id !== frameId ||
      accepted.frame.loaderId !== loaderId ||
      this.#top !== accepted.frame ||
      this.#commits.get(frameId) !== accepted.frame
    )
      return false;
    const worlds = this.#contexts
      .entries()
      .filter((context) => context.mainWorld && context.frameId === frameId);
    return (
      worlds.length === 1 &&
      this.#live(worlds[0]!) &&
      worlds[0]!.uniqueId === accepted.uniqueId &&
      worlds[0]!.description.origin === accepted.frame.securityOrigin
    );
  }
  #trusted(context: ExecutionContextEntry): boolean {
    const document = this.#documents.get(context);
    if (
      !this.#live(context) ||
      !document ||
      this.#top !== document.top ||
      this.#commits.get(document.frame.id) !== document.frame ||
      (this.#security?.document === document.top && this.#security.refused)
    )
      return false;
    // Network's Security.SecurityState is document-scoped TLS authority. The
    // visible Security event is an additional refusal signal; embedders without
    // Chrome's security UI may never emit it.
    if (
      this.#bootstrapDocument?.frame === document.frame &&
      this.#bootstrapDocument.uniqueId === context.uniqueId
    )
      return true;
    const tls = this.#tls.get(document.frame.loaderId);
    return (
      tls?.trusted === true &&
      tls.frameId === document.frame.id &&
      tls.origin === context.description.origin
    );
  }
  #abortIneligible(): void {
    if (this.#pending && !this.#trusted(this.#pending.context)) this.#pending.controller.abort();
  }
  async #onBinding(value: unknown): Promise<void> {
    const event = bindingEvent.safeParse(value);
    if (!event.success || event.data.name !== this.bindingName || this.#closed) return;
    const context = this.#contexts
      .entries()
      .find((entry) => entry.id === event.data.executionContextId);
    if (!context?.uniqueId) return;
    let payload: unknown;
    try {
      payload = JSON.parse(event.data.payload);
    } catch {
      return;
    }
    const parsed = request.safeParse(payload);
    if (!parsed.success) return;
    const call = parsed.data;
    if (call.op === "cancel") {
      if (this.#pending?.id === call.id && this.#pending.context.uniqueId === context.uniqueId)
        this.#pending.controller.abort();
      return;
    }
    if (this.#pending) {
      await this.#reply(context, call.id, {
        error: "OperationError",
        message: errorMessages.OperationError,
      });
      return;
    }
    const options = (
      call.op === "create"
        ? PublicKeyCredentialCreationOptionsJSONSchema
        : PublicKeyCredentialRequestOptionsJSONSchema
    ).safeParse(call.options);
    if (!options.success) {
      await this.#reply(context, call.id, { error: "TypeError", message: errorMessages.TypeError });
      return;
    }
    const controller = new AbortController();
    const pending = { id: call.id, context, controller };
    this.#pending = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(new Refusal("NotAllowedError")), {
        once: true,
      }),
    );
    // Covers CDP validation too: a stalled renderer cannot reserve this tab forever.
    const deadline =
      Date.now() + Math.min(600_000, Math.max(30_000, options.data.timeout ?? 300_000));
    timer = setTimeout(() => controller.abort(), deadline - Date.now());
    try {
      const operation = (async () => {
        const origin = await this.#origin(context);
        const policy = await this.#permissions(context.frameId!);
        if (
          !policy.states.some(
            (state) => state.feature === `publickey-credentials-${call.op}` && state.allowed,
          )
        )
          throw new Refusal("NotAllowedError");
        const requestedRpId = "rp" in options.data ? options.data.rp.id : options.data.rpId;
        const resolved = resolveRpId(origin, requestedRpId);
        if ("error" in resolved) throw new Refusal(resolved.error);
        if (!this.#trusted(context) || controller.signal.aborted)
          throw new Refusal("NotAllowedError");
        const common = {
          targetId: await this.#targetId?.(),
          documentId: context.uniqueId,
          deadline,
          origin,
          rpId: resolved.rpId,
          signal: controller.signal,
          clientDataJSON: serializeClientData({
            type: call.op === "create" ? "webauthn.create" : "webauthn.get",
            challenge: encodeBase64Url(options.data.challenge),
            origin,
          }),
        };
        const outcome = await this.#authenticator.ceremony(
          "rp" in options.data
            ? { ...common, op: "create", options: options.data }
            : { ...common, op: "get", options: options.data },
        );
        if (!this.#trusted(context) || controller.signal.aborted)
          throw new Refusal("NotAllowedError");
        if (outcome.kind === "refused") throw new Refusal(outcome.error);
        if ((call.op === "create") !== (outcome.kind === "created"))
          throw new Refusal("UnknownError");
        return outcome.kind === "created"
          ? buildRegistrationResponseJSON(outcome, {
              credProps: options.data.extensions.credProps === true,
            })
          : buildAuthenticationResponseJSON(outcome);
      })();
      const credential = await Promise.race([operation, aborted]);
      if (this.#pending === pending) this.#pending = null;
      await this.#reply(context, call.id, { credential });
    } catch (error) {
      if (this.#pending === pending) this.#pending = null;
      const name =
        error instanceof Refusal
          ? error.error
          : error instanceof z.ZodError
            ? "NotAllowedError"
            : "UnknownError";
      await this.#reply(context, call.id, {
        error: name,
        message: errorMessages[name],
      });
    } finally {
      clearTimeout(timer);
      if (this.#pending === pending) this.#pending = null;
    }
  }

  async #permissions(frameId: string) {
    try {
      return policyState.parse(await this.#cdp.send("Page.getPermissionsPolicyState", { frameId }));
    } catch {
      throw new Refusal("NotAllowedError");
    }
  }

  async #origin(context: ExecutionContextEntry): Promise<string> {
    const origin = context.description.origin;
    if (
      !context.mainWorld ||
      !context.frameId ||
      typeof origin !== "string" ||
      !this.#trusted(context)
    )
      throw new Refusal("NotAllowedError");
    try {
      if (new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
        throw new Error();
    } catch {
      throw new Refusal("NotAllowedError");
    }
    let tree: { frameTree: FrameTree };
    try {
      tree = z.object({ frameTree }).parse(await this.#cdp.send("Page.getFrameTree"));
    } catch {
      throw new Refusal("NotAllowedError");
    }
    const visit = (node: FrameTree, same: boolean): boolean => {
      const allowed = same && node.frame.securityOrigin === origin;
      if (node.frame.id === context.frameId) return allowed;
      return node.childFrames?.some((child) => visit(child, allowed)) ?? false;
    };
    if (!visit(tree.frameTree, true)) throw new Refusal("NotAllowedError");
    return origin;
  }

  async #reply(
    context: ExecutionContextEntry,
    id: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#live(context)) return;
    // uniqueContextId prevents numeric context reuse from delivering a signature
    // into a replacement document. The provider owns a non-writable reply slot.
    await this.#cdp
      .send("Runtime.evaluate", {
        uniqueContextId: context.uniqueId,
        expression: `this[${JSON.stringify(this.config.replyName)}](${JSON.stringify({ id, ...result })})`,
        returnByValue: true,
      })
      .catch(() => undefined);
  }
}
