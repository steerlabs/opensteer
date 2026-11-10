import {
  BrowserRelayToHostMessageSchema,
  type BrowserRelayToHostMessage,
} from "@opensteer/protocol/browser-relay";
import type {
  BrowserAttachTicketClaims,
  BrowserServerMessage,
  HeldLocalProfile,
} from "@opensteer/protocol/browser";
import type { ReplayLedgerState } from "@opensteer/browser-core/attach-ticket-policy";
import {
  PhoneBrowserError,
  type Epoch,
  type NativeDocumentRef,
  type NativeQualification,
  type NativeTabMetadata,
  type NativeTabRef,
  type PhoneBrowserNativeEvent,
  type PhoneBrowserNativePort,
} from "./native-port.js";
import type { PhoneBrowserClock } from "./manager.js";

export class FakeClock implements PhoneBrowserClock {
  #now = Date.parse("2026-11-09T12:00:00.000Z");
  readonly #scheduled = new Map<() => void, number>();
  now = () => this.#now;
  schedule = (deadline: number, callback: () => void) => {
    this.#scheduled.set(callback, deadline);
    return () => {
      this.#scheduled.delete(callback);
    };
  };
  advance(milliseconds: number): void {
    this.#now += milliseconds;
    for (const [callback, deadline] of this.#scheduled)
      if (deadline <= this.#now) {
        this.#scheduled.delete(callback);
        callback();
      }
  }
}

type Input<Method extends keyof PhoneBrowserNativePort> = PhoneBrowserNativePort[Method] extends (
  input: infer Parameter,
) => unknown
  ? Parameter
  : never;
type FakeTab = {
  sessionId: string;
  presentationGeneration: number;
  state: "live" | "retained" | "discarded";
  metadata: NativeTabMetadata;
  loads: number;
  form: string;
};

export class FakePhoneBrowserNative implements PhoneBrowserNativePort {
  epoch = 0;
  readonly tabs = new Map<string, FakeTab>();
  readonly output: BrowserRelayToHostMessage[] = [];
  readonly profiles = new Map<string, HeldLocalProfile>();
  readonly tickets = new Map<string, BrowserAttachTicketClaims>();
  readonly permits = new Map<string, number>();
  readonly pipes = new Map<string, NativeDocumentRef & { attachmentId: string }>();
  readonly authorizations = new Set<string>();
  readonly actionAttachments = new Map<string, Input<"attachAgent">>();
  readonly capture = new Map<string, boolean>();
  readonly submitted: string[] = [];
  readonly dialogsAnswered: string[] = [];
  readonly calls: { method: string; input: unknown }[] = [];
  readonly #listeners = new Set<(event: PhoneBrowserNativeEvent) => Promise<void>>();
  readonly #ticketChannels = new Map<string, string>();
  readonly #permitChannels = new Map<string, string>();
  readonly #channelClaims = new Map<string, BrowserAttachTicketClaims>();
  readonly #actionPermits = new Map<string, string>();
  transportBlocked = false;
  transportQueueBytes = 0;
  #pendingPicture: { channelId: string; tabId: string } | null = null;
  replay: ReplayLedgerState = { version: 1, highWaterAt: 0, entries: [] };
  actionGate: (() => Promise<void>) | null = null;
  actionError: PhoneBrowserError | null = null;
  erasure: "deleted" | "pending-restart" = "deleted";
  mountError: PhoneBrowserError | null = null;
  #next = 0;
  #covered: string | null = null;
  readonly qualification: NativeQualification;

  constructor(
    platform: "ios" | "android" = "ios",
    readonly now: () => number = () => Date.parse("2026-11-09T12:00:00.000Z"),
  ) {
    this.qualification = {
      platform,
      runtimeId: "phone-runtime",
      storageInstanceId: "11111111-1111-4111-8111-111111111111",
      browser: true,
      sharedControl: true,
      agentActions: platform === "ios",
      cdpBoundary: platform === "android",
      fileStaging: platform === "android",
    };
  }

  async emit(event: PhoneBrowserNativeEvent): Promise<void> {
    if (event.type === "relayCommand") {
      if (event.message.type === "browser.attach")
        this.#ticketChannels.set(event.message.attachHandle, event.message.channelId);
      else if (event.message.type === "browser.client-message" && event.authorityHandle)
        this.#ticketChannels.set(event.authorityHandle, event.message.channelId);
    }
    if (
      event.type === "relayCommand" &&
      event.message.type === "browser.client-message" &&
      event.message.message.type === "agent.action" &&
      event.message.message.request.action.type === "surface.open"
    ) {
      const message = event.message.message;
      const permit = `action:${message.requestId}`;
      this.permits.set(permit, this.now() + message.request.timeoutMs);
      this.#permitChannels.set(permit, event.message.channelId);
      this.#actionPermits.set(permit, message.attachmentId);
    }
    await Promise.all([...this.#listeners].map((listener) => listener(event)));
  }
  onEvent(listener: (event: PhoneBrowserNativeEvent) => Promise<void>) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  fence(reason: string): number {
    this.epoch++;
    this.calls.push({ method: "fence", input: reason });
    for (const tab of this.tabs.values()) if (tab.state === "live") tab.state = "retained";
    this.#covered = null;
    this.pipes.clear();
    this.authorizations.clear();
    this.actionAttachments.clear();
    this.capture.clear();
    this.permits.clear();
    this.#channelClaims.clear();
    this.#permitChannels.clear();
    this.#ticketChannels.clear();
    this.#actionPermits.clear();
    this.drainTransport();
    return this.epoch;
  }
  #check(input: Epoch, method: string): void {
    if (input.epoch !== this.epoch) throw new PhoneBrowserError("forbidden", "Stale native epoch.");
    this.calls.push({ method, input });
  }
  #tab(input: NativeTabRef, method: string): FakeTab {
    this.#check(input, method);
    const tab = this.tabs.get(input.tabId);
    if (!tab || tab.sessionId !== input.sessionId || tab.metadata.generation !== input.generation)
      throw new PhoneBrowserError("target-closed", "Stale native target.");
    return tab;
  }
  #document(input: NativeDocumentRef, method: string): FakeTab {
    const tab = this.#tab(input, method);
    if (tab.state !== "live")
      throw new PhoneBrowserError("target-suspended", "The native view is not live.");
    if (input.documentId !== tab.metadata.documentId)
      throw new PhoneBrowserError("stale-document", "Stale native document.");
    if (input.geometryRevision !== tab.metadata.geometryRevision)
      throw new PhoneBrowserError("stale-geometry", "Stale native geometry.");
    return tab;
  }
  async initialize(input: Input<"initialize">) {
    this.#check(input, "initialize");
    return this.qualification;
  }
  async setForeground(input: Input<"setForeground">) {
    this.#check(input, "setForeground");
  }
  async verifyAttach(input: Input<"verifyAttach">) {
    this.#check(input, "verifyAttach");
    const claims = this.tickets.get(input.attachHandle);
    if (!claims) throw new PhoneBrowserError("forbidden", "Unknown native ticket handle.");
    return {
      claims,
      claimsDigest: input.attachHandle,
      replayState: this.replay,
      maxReplayEntries: 128,
    };
  }
  async commitAttach(input: Input<"commitAttach">) {
    this.#check(input, "commitAttach");
    const claims = this.tickets.get(input.attachHandle);
    if (
      !claims ||
      Date.parse(claims.operationExpiresAt) <= this.now() ||
      Date.parse(claims.expiresAt) <= this.now() ||
      input.claimsDigest !== input.attachHandle ||
      this.replay.entries.some((entry) => entry.nonce === claims.nonce)
    )
      throw new PhoneBrowserError("forbidden", "The ticket was already consumed.");
    this.replay = input.replayTransition;
    this.tickets.delete(input.attachHandle);
    this.permits.set(input.attachHandle, Date.parse(claims.operationExpiresAt));
    const channelId = this.#ticketChannels.get(input.attachHandle);
    if (!channelId) throw new PhoneBrowserError("forbidden", "No native channel.");
    this.#permitChannels.set(input.attachHandle, channelId);
    if (!this.#channelClaims.has(channelId)) this.#channelClaims.set(channelId, claims);
    return input.attachHandle;
  }
  async sendRelay(input: Input<"sendRelay">) {
    this.#check(input, "sendRelay");
    this.output.push(BrowserRelayToHostMessageSchema.parse(input.message));
  }
  async closeChannel(input: Input<"closeChannel">) {
    this.#check(input, "closeChannel");
    for (const key of this.capture.keys())
      if (key.startsWith(`${input.channelId}:`)) this.capture.delete(key);
    this.#channelClaims.delete(input.channelId);
    if (this.#pendingPicture?.channelId === input.channelId) this.drainTransport();
  }
  async ensureProfile(input: Input<"ensureProfile">) {
    this.#check(input, "ensureProfile");
    if ((this.permits.get(input.allocationPermit) ?? 0) <= this.now())
      throw new PhoneBrowserError("forbidden", "No allocation permit.");
    if (input.initialized && !this.profiles.has(input.binding.bindingId))
      throw new PhoneBrowserError("forbidden", "Initialized storage is missing.");
    this.profiles.set(input.binding.bindingId, { phase: "ready", binding: input.binding });
    return input.binding.bindingId;
  }
  async listProfiles(input: Input<"listProfiles">) {
    this.#check(input, "listProfiles");
    return [...this.profiles.values()];
  }
  async eraseProfile(input: Input<"eraseProfile">) {
    this.#check(input, "eraseProfile");
    this.profiles.set(input.binding.bindingId, {
      phase: "deleted",
      binding: input.binding,
      deletionId: input.deletionId,
      erasure: this.erasure,
    });
    return this.erasure;
  }
  async eraseDeployment(input: Input<"eraseDeployment">) {
    this.#check(input, "eraseDeployment");
    for (const profile of this.profiles.values())
      await this.eraseProfile({
        epoch: input.epoch,
        binding: profile.binding,
        deletionId: "22222222-2222-4222-8222-222222222222",
      });
    return [...this.profiles.values()];
  }
  async createTab(input: Input<"createTab">) {
    this.#check(input, "createTab");
    const cdpAttachment = input.allocationPermit.startsWith("cdp:")
      ? this.actionAttachments.get(input.allocationPermit.slice(4))
      : undefined;
    if (
      cdpAttachment
        ? !this.authorizations.has(cdpAttachment.attachmentId) ||
          cdpAttachment.sessionId !== input.sessionId
        : (this.permits.get(input.allocationPermit) ?? 0) <= this.now()
    )
      throw new PhoneBrowserError("forbidden", "No allocation permit.");
    const actionAttachment = this.#actionPermits.get(input.allocationPermit);
    if (
      actionAttachment &&
      this.actionAttachments.get(actionAttachment)?.sessionId !== input.sessionId
    )
      throw new PhoneBrowserError("forbidden", "The action attachment ended.");
    const channelId = cdpAttachment?.channelId ?? this.#permitChannels.get(input.allocationPermit);
    const claims = channelId ? this.#channelClaims.get(channelId) : undefined;
    if (
      !claims ||
      claims.sessionId !== input.sessionId ||
      (claims.identity.kind === "profile-local"
        ? claims.identity.binding.bindingId !== input.storeHandle
        : input.storeHandle !== null)
    )
      throw new PhoneBrowserError("forbidden", "The profile authority changed.");
    if (input.restoreFrom) {
      const retained = this.tabs.get(input.tabId);
      if (
        !retained ||
        retained.state === "live" ||
        retained.sessionId !== input.restoreFrom.sessionId ||
        retained.metadata.generation !== input.restoreFrom.generation
      )
        throw new PhoneBrowserError("target-closed", "The retained tab changed.");
      retained.sessionId = input.sessionId;
      retained.metadata = { ...retained.metadata, generation: ++this.#next };
      return retained.metadata;
    }
    if (input.state === "live" && this.#covered !== null)
      throw new PhoneBrowserError("target-suspended", "Allocation claimed an occupied live place.");
    const metadata: NativeTabMetadata = {
      generation: ++this.#next,
      revision: 1,
      documentId: `document-${this.#next}`,
      geometryRevision: 1,
      captureRevision: 1,
      title: "Page",
      url: input.url ?? "about:blank",
      loading: false,
      navigationFailed: false,
      canGoBack: false,
      canGoForward: false,
      ...input.viewport,
    };
    this.tabs.set(input.tabId, {
      sessionId: input.sessionId,
      presentationGeneration: 0,
      metadata,
      state: input.state,
      loads: 1,
      form: "",
    });
    if (input.state === "live") this.#covered = input.tabId;
    return metadata;
  }
  async destroyTab(input: Input<"destroyTab">) {
    this.#tab(input, "destroyTab");
    this.tabs.delete(input.tabId);
    if (this.#covered === input.tabId) this.#covered = null;
  }
  async suspendTab(input: Input<"suspendTab">) {
    this.#tab(input, "suspendTab").state = input.state;
    if (this.#covered === input.tabId) this.#covered = null;
  }
  async resumeTab(input: Input<"resumeTab">) {
    const tab = this.#tab(input, "resumeTab");
    this.#covered = input.tabId;
    return this.#activate(tab);
  }
  #activate(tab: FakeTab) {
    if (tab.state === "discarded") {
      tab.metadata = {
        ...tab.metadata,
        generation: ++this.#next,
        revision: 1,
        documentId: `document-${this.#next}`,
      };
      tab.loads++;
      tab.form = "";
    }
    tab.state = "live";
    if ([...this.tabs.values()].filter((entry) => entry.state === "live").length > 2)
      throw new Error("The two-live bound was violated.");
    return tab.metadata;
  }
  async mountTab(input: Input<"mountTab">) {
    if (this.mountError) throw this.mountError;
    const tab = this.#tab(input, "mountTab");
    if (input.presentationGeneration < tab.presentationGeneration)
      throw new PhoneBrowserError("not-actionable", "The presentation was superseded.");
    tab.presentationGeneration = input.presentationGeneration;
    if (this.#covered === input.tabId) this.#covered = null;
    return this.#activate(tab);
  }
  async unmountTab(input: Input<"unmountTab">) {
    this.#tab(input, "unmountTab");
  }
  async resizeTab(input: Input<"resizeTab">) {
    const tab = this.#document(input, "resizeTab");
    tab.metadata = {
      ...tab.metadata,
      revision: tab.metadata.revision + 1,
      geometryRevision: tab.metadata.geometryRevision + 1,
      width: input.width,
      height: input.height,
    };
    return tab.metadata;
  }
  async navigate(input: Input<"navigate">) {
    this.#document(input, "navigate");
  }
  async respondDialog(input: Input<"respondDialog">) {
    this.#document(input, "respondDialog");
    if (this.dialogsAnswered.includes(input.dialogId))
      throw new PhoneBrowserError("stale-dialog", "Already answered.");
    this.dialogsAnswered.push(input.dialogId);
  }
  async respondUpload(input: Input<"respondUpload">) {
    this.#document(input, "respondUpload");
    return [];
  }
  async attachAgent(input: Input<"attachAgent">) {
    this.#check(input, "attachAgent");
    this.actionAttachments.set(input.attachmentId, input);
  }
  async detachAgent(input: Input<"detachAgent">) {
    this.#check(input, "detachAgent");
    this.authorizations.delete(input.attachmentId);
    this.actionAttachments.delete(input.attachmentId);
    for (const [handle, pipe] of this.pipes)
      if (pipe.attachmentId === input.attachmentId) this.pipes.delete(handle);
  }
  async performAction(
    input: Input<"performAction">,
  ): ReturnType<PhoneBrowserNativePort["performAction"]> {
    this.#document(input, "performAction");
    if (this.actionGate) await this.actionGate();
    this.#document(input, "performAction-submit");
    const attachment = this.actionAttachments.get(input.attachmentId);
    if (
      !attachment ||
      attachment.channelId !== input.channelId ||
      attachment.actorToken !== input.actorToken ||
      attachment.sessionId !== input.sessionId
    )
      throw new PhoneBrowserError("forbidden", "The native action attachment is retired.");
    if (this.actionError) throw this.actionError;
    const action = input.request.action;
    this.submitted.push(action.type);
    switch (action.type) {
      case "dom.act":
        if (action.kind === "focus") return { type: action.type, outcome: "acted", trusted: false };
        throw new PhoneBrowserError(
          "unsupported-operation",
          "The fake DOM action is not implemented.",
        );
      case "text.insert":
        this.tabs.get(input.tabId)!.form += action.text;
        return { type: action.type };
      case "text.key":
        return { type: action.type };
      case "dom.snapshot":
        return { type: action.type, text: "Page snapshot" };
      case "page.capture":
        this.#direct(input.channelId, {
          type: "agent.result",
          attachmentId: input.attachmentId,
          requestId: input.requestId,
          result: {
            type: "page.capture",
            format: action.format,
            data: "AQ==",
            viewport: { width: 390, height: 760 },
            width: 390,
            height: 760,
          },
        });
        return { type: "delivered" };
      default:
        throw new PhoneBrowserError("unsupported-operation", "The fake action is not implemented.");
    }
  }
  async applyViewerInput(input: Input<"applyViewerInput">) {
    this.#document(input, "applyViewerInput");
  }
  async setCaptureDemand(input: Input<"setCaptureDemand">) {
    const tab = this.#tab(input, "setCaptureDemand");
    this.capture.set(`${input.channelId}:${input.tabId}`, input.frames && tab.state === "live");
  }
  async ackFrame(input: Input<"ackFrame">) {
    this.#tab(input, "ackFrame");
  }
  captureFrame(channelId: string, tabId: string, byteLength = 524288): boolean {
    return (
      !!this.capture.get(`${channelId}:${tabId}`) &&
      this.#queuePicture(channelId, tabId, byteLength)
    );
  }
  #queuePicture(channelId: string, tabId: string, byteLength: number): boolean {
    if (this.#pendingPicture || this.transportQueueBytes) return false;
    this.#pendingPicture = { channelId, tabId };
    this.transportQueueBytes = byteLength;
    if (!this.transportBlocked) this.drainTransport();
    return true;
  }
  drainTransport(): void {
    this.transportQueueBytes = 0;
    this.#pendingPicture = null;
  }
  async captureOnce(input: Input<"captureOnce">) {
    this.#document(input, "captureOnce");
    if (!this.#queuePicture(input.channelId, input.tabId, 1))
      throw new PhoneBrowserError("not-actionable", "The native picture transport is busy.");
    this.#direct(input.channelId, {
      type: "cdp.result",
      requestId: input.requestId,
      result: { data: "AQ==" },
    });
    return "artifact";
  }
  #direct(channelId: string, message: BrowserServerMessage): void {
    const attached = this.output.findLast(
      (entry) => entry.type === "browser.attached" && entry.channelId === channelId,
    );
    if (!attached || attached.type !== "browser.attached")
      throw new PhoneBrowserError("forbidden", "No native delivery route.");
    const { requestId: _requestId, initialPage: _initialPage, ...envelope } = attached;
    this.output.push(
      BrowserRelayToHostMessageSchema.parse({
        ...envelope,
        type: "browser.server-message",
        message,
      }),
    );
  }
  async authorizeCdp(input: Input<"authorizeCdp">) {
    this.#check(input, "authorizeCdp");
    const attachment = this.actionAttachments.get(input.attachmentId);
    if (attachment?.channelId !== input.channelId || attachment.actorToken !== input.actorToken)
      throw new PhoneBrowserError("forbidden", "No native attachment.");
    const attachmentId = attachment.attachmentId;
    this.authorizations.add(attachmentId);
    return { attachmentId, filesRoot: "/native/session-files" };
  }
  async openCdpPipe(input: Input<"openCdpPipe">) {
    this.#document(input, "openCdpPipe");
    if (!this.authorizations.has(input.attachmentId))
      throw new PhoneBrowserError("forbidden", "No CDP attachment.");
    const handle = `pipe-${++this.#next}`;
    this.pipes.set(handle, input);
    return handle;
  }
  async sendCdp(input: Input<"sendCdp">) {
    this.#document(input, "sendCdp");
    if (!this.pipes.has(input.pipeHandle))
      throw new PhoneBrowserError("forbidden", "Closed CDP pipe.");
    if (input.method === "Runtime.enable")
      await this.emit({
        type: "cdpEvent",
        epoch: input.epoch,
        pipeHandle: input.pipeHandle,
        method: "Runtime.executionContextCreated",
        params: {
          context: {
            id: 1,
            uniqueId: "native-context",
            origin: "https://example.com",
            name: "",
            auxData: { isDefault: true, frameId: "frame-1" },
          },
        },
      });
    if (input.method === "Page.getFrameTree")
      return { frameTree: { frame: { id: "frame-1", url: "https://example.com" } } };
    return {};
  }
  async closeCdpPipe(input: Input<"closeCdpPipe">) {
    this.#check(input, "closeCdpPipe");
    this.pipes.delete(input.pipeHandle);
  }
  async releaseCdp(input: Input<"releaseCdp">) {
    this.#check(input, "releaseCdp");
    this.authorizations.delete(input.attachmentId);
  }
  async stageChunk(input: Input<"stageChunk">) {
    this.#check(input, "stageChunk");
    if (this.actionAttachments.get(input.attachmentId)?.sessionId !== input.sessionId)
      throw new PhoneBrowserError("forbidden", "The staging attachment ended.");
    return { fileId: input.fileId, complete: true };
  }
  async finishSessionFiles(input: Input<"finishSessionFiles">) {
    this.#check(input, "finishSessionFiles");
  }
  async cancelDownload(input: Input<"cancelDownload">) {
    this.#check(input, "cancelDownload");
  }
}
