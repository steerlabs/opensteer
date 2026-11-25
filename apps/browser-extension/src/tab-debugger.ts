import {
  BrowserSourceTabAssembly,
  BrowserSourceTabCommandSchema,
  browserSourceTabBufferedBytes,
  browserSourceTabMessageBytes,
  browserSourceTabParts,
  browserSourceTabPending,
  type BrowserSourceClientFrame,
  type BrowserSourceTabCommand,
  type BrowserSourceTabPart,
  type BrowserSourceTabShared,
} from "@opensteer/browser-source-wire/frames";
import {
  ThisHomeAddressSet,
  loopbackRequestPatterns,
  noHomeAddresses,
  type ThisHomeAddresses,
} from "@opensteer/shared/homeAddress";
import type { TabShareProblemCode } from "./messages.js";
import { maxChromeDetachReceipts } from "./storage.js";

type TabFrame = Extract<BrowserSourceClientFrame, { type: `tab.${string}` }>;
type Attachment = { id: string; ready: Promise<void> };
type ShareGroup = { readonly detaching: Set<Promise<void>>; detachFailed: boolean };
type DetachJournal = {
  readonly pending: readonly string[];
  readonly record: (shareId: string) => Promise<void>;
  readonly acknowledge: (shareId: string) => Promise<void>;
};
type Share = {
  readonly tabId: number;
  readonly sourceId: string;
  readonly group: ShareGroup;
  readonly link: ChromeTabLink;
  info: BrowserSourceTabShared;
  attachment?: Attachment;
  detachFailed?: boolean;
};
type TabView = { readonly shareId: string; readonly title: string; readonly url: string };
/** What one paired Home is: the destinations it paired with, and the addresses it last sent. */
type HomeOf = { paired: readonly string[]; sent: ThisHomeAddresses; set: ThisHomeAddressSet };
type SessionRules = NonNullable<ChromeApi["declarativeNetRequest"]>;

const maxShares = 64;
const encoder = new TextEncoder();
const browserVersion = /Chrome\/(\d+(?:\.\d+){3})/u.exec(navigator.userAgent)?.[1];

export class TabShareProblem extends Error {
  readonly reason: TabShareProblemCode;

  constructor(reason: TabShareProblemCode, options?: ErrorOptions) {
    super(reason, options);
    this.reason = reason;
  }
}

export class ChromeTabLink {
  readonly #assembly = new BrowserSourceTabAssembly();
  readonly #write: (frame: TabFrame) => boolean;
  readonly #stop: () => void;
  readonly #execute: (command: BrowserSourceTabCommand) => Promise<Record<string, unknown>>;
  #pending = 0;
  #bytes = 0;
  #closed = false;

  constructor(
    write: (frame: TabFrame) => boolean,
    stop: () => void,
    execute: (command: BrowserSourceTabCommand) => Promise<Record<string, unknown>>,
  ) {
    this.#write = write;
    this.#stop = stop;
    this.#execute = execute;
  }

  read(frame: BrowserSourceTabPart<"tab.command">): void {
    if (this.#closed) return;
    const value = this.#assembly.read(frame);
    if (value === undefined) return;
    const command = BrowserSourceTabCommandSchema.parse(value);
    const bytes = encoder.encode(JSON.stringify(value)).length;
    if (
      this.#pending >= browserSourceTabPending ||
      this.#bytes + bytes > browserSourceTabBufferedBytes
    ) {
      this.#stop();
      return;
    }
    this.#pending++;
    this.#bytes += bytes;
    const address = {
      requestId: command.requestId,
      shareId: command.shareId,
      attachmentId: command.attachmentId,
    };
    void this.#execute(command)
      .then(
        (result) => this.send("tab.result", { ...address, ok: true, result }),
        (error: unknown) =>
          this.send("tab.result", {
            ...address,
            ok: false,
            error: String(
              error instanceof Error ? error.message : "Chrome debugger command failed.",
            ).slice(0, 4096),
          }),
      )
      .catch(this.#stop)
      .finally(() => {
        this.#pending--;
        this.#bytes -= bytes;
      });
  }

  send(type: "tab.result" | "tab.event", message: unknown): void {
    if (this.#closed) return;
    const bytes = encoder.encode(JSON.stringify(message));
    if (bytes.length > browserSourceTabMessageBytes && type === "tab.result") {
      const result = message as {
        requestId: string;
        shareId: string;
        attachmentId: string;
        ok: boolean;
      };
      this.send("tab.result", {
        requestId: result.requestId,
        shareId: result.shareId,
        attachmentId: result.attachmentId,
        ok: false,
        error: "Chrome debugger response exceeds the CDP message limit.",
      });
      return;
    }
    try {
      for (const frame of browserSourceTabParts(type, bytes)) if (!this.announce(frame)) return;
    } catch {
      this.#stop();
    }
  }

  announce(frame: TabFrame): boolean {
    if (this.#closed) return false;
    if (this.#write(frame)) return true;
    this.#stop();
    return false;
  }

  close(): void {
    this.#closed = true;
  }
}

export class ChromeTabDebugger {
  readonly #debugger: ChromeDebugger;
  readonly #shares = new Map<string, Share>();
  readonly #byTab = new Map<number, Share>();
  readonly #detaching = new Map<number, Promise<void>>();
  readonly #links = new Map<string, ChromeTabLink>();
  readonly #detachReceipts = new WeakSet<ChromeTabLink>();
  readonly #journals = new WeakMap<ChromeTabLink, DetachJournal & { receipts: Set<string> }>();
  readonly #stoppingRoots = new Map<string, string>();
  readonly #popups = new Map<number, { parent: Share; attachment: Attachment }>();
  readonly #homes = new WeakMap<ChromeTabLink, HomeOf>();
  readonly #rules: SessionRules | undefined;
  /** The session rules blocking the Home's addresses for each attached shared tab. */
  readonly #ruleIds = new Map<number, Promise<readonly number[]>>();
  #nextRuleId = 1;
  /**
   * Session rules outlive this service worker; its shares and attachments do not. A worker that
   * starts again removes every rule it left before it adds one, so none blocks a tab that is the
   * person's again and none collides with a new rule's id.
   */
  readonly #rulesCleared: Promise<void>;

  constructor(
    api: ChromeDebugger,
    tabs: ChromeApi["tabs"],
    navigation?: ChromeApi["webNavigation"],
    rules?: SessionRules,
  ) {
    this.#debugger = api;
    this.#rules = rules;
    this.#rulesCleared = rules
      ? rules
          .getSessionRules()
          .then((left) =>
            left.length
              ? rules.updateSessionRules({ removeRuleIds: left.map((rule) => rule.id) })
              : undefined,
          )
      : Promise.resolve();
    api.onEvent.addListener((source, method, params) => {
      const share = source.tabId === undefined ? undefined : this.#byTab.get(source.tabId);
      if (!share?.attachment) return;
      if (method === "Target.attachedToTarget") {
        const type = (params?.targetInfo as { type?: unknown } | undefined)?.type;
        if (type !== "iframe" && type !== "worker") return;
      }
      share.link.send("tab.event", {
        shareId: share.info.shareId,
        attachmentId: share.attachment.id,
        method,
        params: params ?? {},
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      });
    });
    api.onDetach.addListener((source) => {
      const share = source.tabId === undefined ? undefined : this.#byTab.get(source.tabId);
      if (share?.attachment && !this.#detaching.has(share.tabId)) {
        delete share.attachment;
        void this.#releaseHome(share.tabId).catch(() => undefined);
        void this.#unshare(share);
      }
    });
    navigation?.onCreatedNavigationTarget.addListener(({ sourceTabId, tabId, url }) => {
      const parent = this.#byTab.get(sourceTabId);
      if (
        !parent?.attachment ||
        this.#byTab.has(tabId) ||
        !canDebug(url || "about:blank", this.#home(parent.link))
      )
        return;
      if (this.#shares.size + this.#popups.size >= maxShares) return;
      this.#popups.set(tabId, { parent, attachment: parent.attachment });
      void tabs
        .get(tabId)
        .then((tab) => this.#sharePopup(tabId, tab))
        .catch(() => undefined);
    });
    tabs.onUpdated.addListener((tabId, changes, tab) => {
      const share = this.#byTab.get(tabId);
      if (!share && this.#popups.has(tabId)) {
        void this.#sharePopup(tabId, tab).catch(() => undefined);
        return;
      }
      if (!share || (changes.url === undefined && changes.title === undefined)) return;
      const url = tab.url ?? share.info.url;
      // A shared tab that went to a page no agent may be on (this Home's among them) is shared no
      // more: the agent's attachment to it ends.
      if (!canDebug(url, this.#home(share.link))) {
        void this.#unshare(share);
        return;
      }
      share.info = {
        ...share.info,
        url: url.slice(0, 8192),
        title: (tab.title ?? "").slice(0, 1024),
      };
      share.link.announce(share.info);
    });
    const remove = (tabId: number) => {
      this.#popups.delete(tabId);
      const share = this.#byTab.get(tabId);
      if (share) void this.#unshare(share);
    };
    tabs.onRemoved.addListener(remove);
    tabs.onReplaced.addListener((_added, removed) => remove(removed));
  }

  connect(
    sourceId: string,
    send: (frame: TabFrame) => boolean,
    stop: () => void,
    detachReceipts = false,
    journal?: DetachJournal,
    paired: readonly string[] = [],
  ): ChromeTabLink {
    this.disconnect(sourceId);
    const link = new ChromeTabLink(send, stop, (command) => this.#execute(link, command));
    this.#links.set(sourceId, link);
    this.#setHome(link, paired, noHomeAddresses);
    if (detachReceipts) this.#detachReceipts.add(link);
    if (journal) {
      const receipts = new Set(journal.pending);
      this.#journals.set(link, { ...journal, receipts });
      for (const shareId of receipts) if (!link.announce({ type: "tab.detached", shareId })) break;
    }
    return link;
  }

  disconnect(sourceId: string): void {
    const link = this.#links.get(sourceId);
    if (!link) return;
    this.#links.delete(sourceId);
    link.close();
    for (const share of this.#shares.values()) if (share.link === link) void this.#unshare(share);
  }

  async acknowledgeDetach(sourceId: string, shareId: string): Promise<void> {
    const link = this.#links.get(sourceId);
    const journal = link && this.#journals.get(link);
    if (!journal?.receipts.has(shareId)) return;
    await journal.acknowledge(shareId);
    journal.receipts.delete(shareId);
  }

  list(sourceId: string): readonly TabView[] {
    const link = this.#links.get(sourceId);
    return [...this.#shares.values()]
      .filter((share) => share.link === link)
      .map(({ info }) => ({
        shareId: info.shareId,
        title: info.title,
        url: info.url,
      }));
  }

  canShare(sourceId: string): boolean {
    return this.#links.has(sourceId);
  }

  async share(sourceId: string, tab: ChromeTab): Promise<void> {
    const link = this.#links.get(sourceId);
    const tabId = tab.id;
    if (!link) throw new TabShareProblem("home-offline");
    if (tabId === undefined) throw new TabShareProblem("tab-unavailable");
    if (!canDebug(tab.url ?? tab.pendingUrl ?? "", this.#home(link)))
      throw new TabShareProblem("unsupported-page");

    const alreadySharedHere = () => {
      if (this.#links.get(sourceId) !== link) throw new TabShareProblem("home-offline");
      const existing = this.#byTab.get(tabId);
      if (existing && existing.link !== link) throw new TabShareProblem("shared-elsewhere");
      if (existing?.detachFailed) throw new TabShareProblem("detach-unconfirmed");
      if (!existing && this.#atCapacity(sourceId)) throw new TabShareProblem("capacity");
      return existing !== undefined;
    };
    const detaching = this.#detaching.get(tabId);
    if (detaching)
      await detaching.catch((cause: unknown) => {
        throw new TabShareProblem("detach-unconfirmed", { cause });
      });
    if (alreadySharedHere()) return;
    const targetId = await this.#targetId(tabId).catch((cause: unknown) => {
      throw new TabShareProblem("target-unavailable", { cause });
    });
    if (alreadySharedHere()) return;
    if (!targetId) throw new TabShareProblem("target-unavailable");
    this.#share(sourceId, link, tabId, tab, targetId);
  }

  stop(sourceId: string, shareId: string): void {
    const share = this.#shares.get(shareId);
    if (share && share.link === this.#links.get(sourceId)) void this.#unshare(share);
  }

  #atCapacity(sourceId: string): boolean {
    if (this.#shares.size >= maxShares) return true;
    const link = this.#links.get(sourceId);
    const journal = link && this.#journals.get(link);
    const live = [...this.#shares.values()].filter(
      (share) => share.sourceId === sourceId && !share.info.openerShareId,
    ).length;
    const stopping = [...this.#stoppingRoots.values()].filter(
      (source) => source === sourceId,
    ).length;
    return !!journal && live + stopping + journal.receipts.size >= maxChromeDetachReceipts;
  }

  async #targetId(tabId: number): Promise<string | undefined> {
    const targets = await this.#debugger.getTargets();
    return targets.find((target) => target.tabId === tabId && target.type === "page")?.id;
  }

  async #sharePopup(tabId: number, tab: ChromeTab): Promise<void> {
    const candidate = this.#popups.get(tabId);
    if (!candidate) return;
    const { parent, attachment } = candidate;
    const targetId = await this.#targetId(tabId);
    if (!targetId || this.#popups.get(tabId) !== candidate) return;
    this.#popups.delete(tabId);
    if (
      parent.attachment !== attachment ||
      this.#byTab.has(tabId) ||
      this.#shares.size >= maxShares
    )
      return;
    if (!canDebug(tab.url || tab.pendingUrl || "about:blank", this.#home(parent.link))) return;
    this.#share(parent.sourceId, parent.link, tabId, tab, targetId, parent);
  }

  #share(
    sourceId: string,
    link: ChromeTabLink,
    tabId: number,
    tab: ChromeTab,
    targetId: string,
    opener?: Share,
  ): void {
    const info: BrowserSourceTabShared = {
      type: "tab.shared",
      shareId: crypto.randomUUID(),
      targetId,
      ...(browserVersion ? { browserVersion } : {}),
      url: (tab.url || "about:blank").slice(0, 8192),
      title: (tab.title ?? "").slice(0, 1024),
      ...(opener ? { openerShareId: opener.info.shareId } : {}),
    };
    const group = opener?.group ?? { detaching: new Set(), detachFailed: false };
    const share: Share = { info, link, tabId, sourceId, group };
    if (!link.announce(info)) throw new TabShareProblem("home-offline");
    this.#shares.set(info.shareId, share);
    this.#byTab.set(tabId, share);
  }

  #unshare(share: Share): Promise<void> {
    if (!this.#shares.delete(share.info.shareId)) return Promise.resolve();
    this.#byTab.delete(share.tabId);
    for (const [id, candidate] of this.#popups)
      if (candidate.parent === share) this.#popups.delete(id);
    share.link.announce({ type: "tab.unshared", shareId: share.info.shareId });
    const children = [...this.#shares.values()].filter(
      (child) => child.info.openerShareId === share.info.shareId,
    );
    const {
      group,
      sourceId,
      link,
      info: { shareId, openerShareId },
    } = share;
    const root = !openerShareId;
    if (root) this.#stoppingRoots.set(shareId, sourceId);
    const physical = this.#detach(share);
    group.detaching.add(physical);
    const descendants = children.map((child) => this.#unshare(child));
    const detached = Promise.all([physical, ...descendants, ...(root ? group.detaching : [])])
      .then(async () => {
        if (!this.#detachReceipts.has(link) || (root && group.detachFailed)) return;
        const journal = root && this.#journals.get(link);
        if (journal) {
          await journal.record(shareId);
          const current = this.#links.get(sourceId);
          const active = current && this.#journals.get(current);
          if (active) {
            active.receipts.add(shareId);
            current.announce({ type: "tab.detached", shareId });
          }
        } else link.announce({ type: "tab.detached", shareId });
      })
      .finally(() => {
        group.detaching.delete(physical);
        if (root) this.#stoppingRoots.delete(shareId);
      });
    void detached.catch((error: unknown) => console.error("Chrome tab cleanup failed", error));
    return detached;
  }

  #detach(share: Share): Promise<void> {
    const current = share.attachment;
    if (!current) {
      // Whatever path ends this share, no rule outlives an agent's hold of its tab (D1).
      void this.#releaseHome(share.tabId).catch(() => undefined);
      const pending = this.#detaching.get(share.tabId);
      if (pending) return pending;
      return share.detachFailed
        ? Promise.reject(
            new Error("Opensteer couldn’t confirm that Chrome stopped sharing this tab."),
          )
        : Promise.resolve();
    }
    delete share.attachment;
    const job = current.ready
      .then(
        () =>
          this.#debugger.detach({ tabId: share.tabId }).catch(async (error: unknown) => {
            const targets = await this.#debugger.getTargets();
            if (targets.some((target) => target.tabId === share.tabId && target.attached !== false))
              throw error;
          }),
        () => undefined,
      )
      // The tab is the person's again: its requests to the Home are theirs.
      .then(() => this.#releaseHome(share.tabId))
      .catch((error: unknown) => {
        share.detachFailed = true;
        share.group.detachFailed = true;
        throw error;
      })
      .finally(() => {
        if (this.#detaching.get(share.tabId) === job) this.#detaching.delete(share.tabId);
      });
    this.#detaching.set(share.tabId, job);
    return job;
  }

  async #execute(
    link: ChromeTabLink,
    command: BrowserSourceTabCommand,
  ): Promise<Record<string, unknown>> {
    const share = this.#shares.get(command.shareId);
    if (!share || share.link !== link) throw new Error("This Chrome tab is no longer shared.");
    if (command.action === "unshare") {
      await this.#unshare(share);
      return {};
    }
    if (command.action === "detach") {
      if (share.attachment?.id === command.attachmentId) await this.#detach(share);
      return {};
    }
    if (share.detachFailed)
      throw new Error("Opensteer couldn’t confirm that Chrome stopped sharing this tab.");
    // A new attachment brings this Home's addresses as they are now (D2).
    if (command.homeAddresses) {
      const home = this.#homes.get(link);
      this.#setHome(link, home?.paired ?? [], command.homeAddresses);
    }
    const existing = share.attachment;
    if (existing && existing.id !== command.attachmentId)
      throw new Error("Chrome stopped sharing this tab.");
    const attachment = (share.attachment ??= {
      id: command.attachmentId,
      ready: (this.#detaching.get(share.tabId) ?? Promise.resolve()).then(async () => {
        if (this.#shares.get(command.shareId) !== share)
          throw new Error("This Chrome tab is no longer shared.");
        // An agent drives this tab from here: it may not be on, or reach, this Home's addresses.
        if (!canDebug(share.info.url, this.#home(link)))
          throw new Error("This Chrome tab is no longer shared.");
        await this.#blockHome(share.tabId, this.#home(link));
        try {
          return await this.#debugger.attach({ tabId: share.tabId }, "1.3");
        } catch (error) {
          // No agent drives it: its rules go with the attachment that failed (D1).
          await this.#releaseHome(share.tabId).catch(() => undefined);
          throw error;
        }
      }),
    });
    try {
      await attachment.ready;
    } catch (error) {
      if (share.attachment === attachment) delete share.attachment;
      throw error;
    }
    if (share.attachment !== attachment) throw new Error("Chrome stopped sharing this tab.");
    return (
      (await this.#debugger.sendCommand(
        {
          tabId: share.tabId,
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        },
        command.method,
        command.params,
      )) ?? {}
    );
  }

  /** This Home's addresses as this link knows them: its paired destinations and what it sent. */
  #home(link: ChromeTabLink): ThisHomeAddressSet {
    return this.#homes.get(link)?.set ?? emptyHome;
  }

  #setHome(link: ChromeTabLink, paired: readonly string[], sent: ThisHomeAddresses): void {
    const loopbackPorts = new Set(sent.loopbackPorts);
    // A paired destination on loopback is this Home on any loopback name for its port.
    for (const origin of paired) {
      const port = loopbackPort(origin);
      if (port !== undefined) loopbackPorts.add(port);
    }
    this.#homes.set(link, {
      paired,
      sent,
      set: new ThisHomeAddressSet({
        origins: [...paired, ...sent.origins],
        loopbackPorts: [...loopbackPorts],
      }),
    });
  }

  /**
   * The second line (D5): while an agent drives a shared tab, a session rule blocks its every
   * request to this Home's addresses, a navigation as much as a fetch, so no cookie of the Home is
   * sent from it. Installed before the debugger attaches; an attachment is refused without it.
   */
  async #blockHome(tabId: number, home: ThisHomeAddressSet): Promise<void> {
    if (!this.#rules || home.empty || this.#ruleIds.has(tabId)) return;
    await this.#rulesCleared;
    if (this.#ruleIds.has(tabId)) return;
    // The same patterns the shared predicate refuses, over pages, frames, requests and sockets.
    const patterns = home.requestPatterns();
    // On a Mac the Home's session cookie is kept for the loopback host, not its port: an attached
    // tab sends no cookie to any loopback destination (M4). A session rule can remove only the
    // whole Cookie header, not one cookie, so a person's own local site sees that tab signed out
    // while an agent is attached to it. A Linux Home's cookie is __Host- on its HTTPS origin and
    // reaches no other host.
    const loopback = loopbackRequestPatterns();
    const ids = [...patterns, ...loopback].map(() => this.#nextRuleId++);
    const rules: ChromeSessionRule[] = [
      ...patterns.map((regexFilter, index) => ({
        id: ids[index]!,
        priority: 1,
        action: { type: "block" as const },
        condition: { tabIds: [tabId], regexFilter, resourceTypes: allResourceTypes },
      })),
      ...loopback.map((regexFilter, index) => ({
        id: ids[patterns.length + index]!,
        priority: 1,
        action: {
          type: "modifyHeaders" as const,
          requestHeaders: [{ header: "cookie", operation: "remove" as const }],
        },
        condition: { tabIds: [tabId], regexFilter, resourceTypes: allResourceTypes },
      })),
    ];
    const installed = this.#rules.updateSessionRules({ addRules: rules }).then(() => ids);
    this.#ruleIds.set(tabId, installed);
    try {
      await installed;
    } catch (error) {
      this.#ruleIds.delete(tabId);
      throw error;
    }
  }

  async #releaseHome(tabId: number): Promise<void> {
    const installed = this.#ruleIds.get(tabId);
    if (!installed || !this.#rules) return;
    this.#ruleIds.delete(tabId);
    const ids = await installed.catch(() => [] as const);
    if (ids.length) await this.#rules.updateSessionRules({ removeRuleIds: [...ids] });
  }
}

const emptyHome = new ThisHomeAddressSet(noHomeAddresses);
const allResourceTypes = [
  "main_frame",
  "sub_frame",
  "stylesheet",
  "script",
  "image",
  "font",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "websocket",
  "webtransport",
  "webbundle",
  "other",
] as const;

function loopbackPort(origin: string): number | undefined {
  try {
    const url = new URL(origin);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return undefined;
    return Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  } catch {
    return undefined;
  }
}

/** A tab an agent may be given: the web or a blank page, and never an address of this Home. */
function canDebug(url: string, home: ThisHomeAddressSet): boolean {
  return (url === "about:blank" || /^https?:\/\//iu.test(url)) && !home.includesReported(url);
}
