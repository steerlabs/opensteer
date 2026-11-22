import {
  cloudComputerDeleteConfirmation,
  type CloudComputerListResponse,
  type CloudComputerPreparationStep,
  type CloudComputerView,
  type WorkAssignmentId,
} from "@opensteer/control-plane-protocol";
import type {
  DesktopCloudComputerActInput,
  DesktopCloudComputerFailure,
  DesktopWorkHome,
} from "@opensteer/protocol/desktop";
import type { CloudComputerAccount } from "../connections/account-cloud-computers.js";
import {
  cloudComputerPriceLine,
  cloudComputerReasonSentence,
  cloudComputerStepLabel,
  cloudWords,
  orgWords,
  workHomeStatusLabel,
  workPolicyLines,
} from "./cloud-computer-copy.js";

export type CloudComputerPlan = CloudComputerListResponse["plan"];
export type CloudComputerTone = "neutral" | "good" | "attention" | "bad";

/** The plan as a person reads it: its price in its own currency, with its interval. */
export interface CloudComputerPlanView {
  readonly name: string;
  readonly price: string;
  /** "$20.00 a month", or the price alone when the plan has no interval. */
  readonly line: string;
}

export function cloudComputerPlanView(
  plan: CloudComputerPlan,
  locale?: string,
): CloudComputerPlanView {
  return { name: plan.name, ...cloudComputerPriceLine(plan, locale) };
}

/** One preparation step the Account reports, in its words and state. */
export interface CloudComputerStepView {
  readonly id: CloudComputerPreparationStep["id"];
  readonly label: string;
  readonly state: CloudComputerPreparationStep["state"];
}

export interface CloudComputerStatusView {
  readonly label: string;
  readonly tone: CloudComputerTone;
  /** The Account's own sentence, when it gave one. */
  readonly reason: string | null;
}

export interface CloudComputerBrowserIpView {
  readonly label: string;
  readonly detail: string;
  readonly tone: CloudComputerTone;
}

/** One Cloud Computer as its status page shows it. */
export interface CloudComputerDetail {
  readonly id: CloudComputerView["id"];
  readonly status: CloudComputerStatusView;
  /** Its https address, once it is ready. */
  readonly address: string | null;
  /** The address without its scheme, for a row. */
  readonly host: string | null;
  readonly browserIp: CloudComputerBrowserIpView;
  /** The Home this computer is, once the Account has pinned its identity; how it is opened. */
  readonly deploymentId: string | null;
  /** Where it runs, the browser's public address and when it renews: each only when known. */
  readonly region: string | null;
  readonly browserAddress: string | null;
  readonly renews: string | null;
  readonly lastBackup: string | null;
  /** The Account's setup steps while preparing; null when it reports none. */
  readonly steps: readonly CloudComputerStepView[] | null;
  readonly canSuspend: boolean;
  readonly canResume: boolean;
  /** False while a deletion waits on the payment provider: only that state shows. */
  readonly canDelete: boolean;
}

export type CloudComputerScreen =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly failure: DesktopCloudComputerFailure }
  /**
   * None yet: what it is and, while checkout sells one, its price (`plan`, from the
   * Account's offer; null when nothing is for sale). `waiting` once checkout was opened here.
   */
  | {
      readonly kind: "offer";
      readonly plan: CloudComputerPlanView | null;
      readonly waiting: boolean;
      readonly deleted: boolean;
    }
  | {
      readonly kind: "preparing";
      readonly computer: CloudComputerDetail;
      readonly plan: CloudComputerPlanView;
    }
  | {
      /** Ready, suspended or needing attention: its status page. */
      readonly kind: "computer";
      readonly computer: CloudComputerDetail;
      readonly plan: CloudComputerPlanView;
    };

function hostOf(address: string): string {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
}

export function cloudComputerDetail(view: CloudComputerView, locale?: string): CloudComputerDetail {
  const reason =
    view.status === "suspended" || view.status === "needs_attention"
      ? (cloudComputerReasonSentence(view.reasonCode) ?? view.reason)
      : null;
  const status: CloudComputerStatusView =
    view.status === "ready"
      ? { label: cloudWords("cloud.status.running"), tone: "good", reason: null }
      : view.status === "preparing"
        ? { label: cloudWords("cloud.status.preparing"), tone: "neutral", reason: null }
        : view.status === "suspended"
          ? { label: cloudWords("cloud.status.suspended"), tone: "neutral", reason }
          : view.status === "needs_attention"
            ? { label: cloudWords("cloud.status.attention"), tone: "attention", reason }
            : { label: "Deleted", tone: "neutral", reason: null };
  const deletionPending =
    view.status === "needs_attention" && view.reasonCode === "cloud-computer-deletion-pending";
  const browserIp: CloudComputerBrowserIpView =
    view.egress === "assigned"
      ? {
          label: cloudWords("cloud.ip.assigned"),
          detail: cloudWords("cloud.ip.assignedDetail"),
          tone: "good",
        }
      : view.egress === "pending"
        ? {
            label: cloudWords("cloud.ip.pending"),
            detail: cloudWords("cloud.ip.pendingDetail"),
            tone: "neutral",
          }
        : {
            label: cloudWords("cloud.ip.paused"),
            detail: cloudWords("cloud.ip.pausedDetail"),
            tone: "bad",
          };
  const address = view.status === "ready" ? view.address : null;
  return {
    id: view.id,
    status,
    address,
    host: address === null ? null : hostOf(address),
    browserIp,
    deploymentId: view.deploymentId ?? null,
    region: view.region?.label ?? null,
    browserAddress: view.egressAddress ?? null,
    renews: view.renewsAt ? cloudWords("cloud.renews", { date: day(view.renewsAt, locale) }) : null,
    lastBackup: view.lastBackupAt
      ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(view.lastBackupAt),
        )
      : null,
    steps:
      view.status === "preparing" && view.steps && view.steps.length > 0
        ? view.steps.map((step) => ({
            id: step.id,
            label: cloudComputerStepLabel(step.id),
            state: step.state,
          }))
        : null,
    canSuspend: !deletionPending && (view.status === "ready" || view.status === "needs_attention"),
    canResume: view.status === "suspended",
    canDelete: !deletionPending,
  };
}

function day(iso: string, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
}

/* ------------------------------------------------------------------------- *
 * Work Homes: an organization pays for and governs them; the person owns them.
 * ------------------------------------------------------------------------- */

/** One work Home as the person's Cloud Computer screen shows it: no billing or power. */
export interface WorkHomeCard {
  readonly assignmentId: WorkAssignmentId;
  readonly organizationName: string;
  readonly title: string;
  readonly badge: string;
  readonly status: CloudComputerStatusView;
  readonly address: string | null;
  readonly host: string | null;
  readonly deploymentId: string | null;
  readonly region: string | null;
  readonly browserAddress: string | null;
  readonly lastBackup: string | null;
  readonly steps: readonly CloudComputerStepView[] | null;
  readonly policy: ReturnType<typeof workPolicyLines>;
  readonly policyTitle: string;
  readonly managed: string;
  /** Opens "What {organization} can see". */
  readonly seeTitle: string;
}

export function workHomeCard(work: DesktopWorkHome, locale?: string): WorkHomeCard {
  const { assignment, policy } = work.home;
  const organization = assignment.organizationName;
  const computer = work.computer ? cloudComputerDetail(work.computer, locale) : null;
  const tone: CloudComputerTone = assignment.signInCut
    ? "attention"
    : assignment.homeStatus === "ready"
      ? "good"
      : assignment.homeStatus === "needs_attention"
        ? "attention"
        : "neutral";
  const address = assignment.address ?? computer?.address ?? null;
  return {
    assignmentId: assignment.assignmentId,
    organizationName: organization,
    title: orgWords("org.work.title", { organization }),
    badge: orgWords("org.work.badge", { organization }),
    status: { label: workHomeStatusLabel(assignment), tone, reason: assignment.reason },
    address,
    host: address === null ? null : hostOf(address),
    deploymentId: computer?.deploymentId ?? null,
    region: computer?.region ?? null,
    browserAddress: computer?.browserAddress ?? null,
    lastBackup: computer?.lastBackup ?? null,
    steps: assignment.homeStatus === "preparing" ? (computer?.steps ?? null) : null,
    policy: workPolicyLines(policy),
    policyTitle: orgWords("org.work.policy", { organization }),
    managed: orgWords("org.work.managed", { organization }),
    seeTitle: orgWords("org.work.see.title", { organization }),
  };
}

/** The "Work · {organization}" badge for each work Home the Account has pinned, by Home. */
export function workHomeBadges(cards: readonly WorkHomeCard[]): ReadonlyMap<string, WorkHomeCard> {
  const badges = new Map<string, WorkHomeCard>();
  for (const card of cards) if (card.deploymentId) badges.set(card.deploymentId, card);
  return badges;
}

/** The person's one personal Cloud Computer: the newest that isn't deleted or work. */
export function currentCloudComputer(
  computers: readonly CloudComputerView[],
  work: readonly DesktopWorkHome[] = [],
): CloudComputerView | null {
  const workIds = new Set(work.map(({ home }) => home.assignment.computerId));
  return (
    computers.find((computer) => computer.status !== "deleted" && !workIds.has(computer.id)) ?? null
  );
}

export function cloudComputerScreen(input: {
  readonly read: CloudComputerReadState;
  readonly checkoutOpened: boolean;
  readonly deleted: boolean;
  readonly locale?: string;
}): CloudComputerScreen {
  const { read } = input;
  if (read.kind === "loading") return { kind: "loading" };
  if (read.kind === "failed") return { kind: "failed", failure: read.failure };
  const plan = cloudComputerPlanView(read.data.plan, input.locale);
  const current = currentCloudComputer(read.data.computers, read.work);
  if (current === null)
    return {
      kind: "offer",
      // A price for buying comes only from what checkout sells now.
      plan: read.data.offer ? cloudComputerPlanView(read.data.offer, input.locale) : null,
      waiting: input.checkoutOpened,
      deleted: input.deleted,
    };
  const computer = cloudComputerDetail(current, input.locale);
  if (current.status === "preparing") return { kind: "preparing", computer, plan };
  return { kind: "computer", computer, plan };
}

/**
 * Where checkout and billing happen: the Opensteer website, where the Account is
 * signed in. The Account takes checkout only from its own website session, never
 * from an app's token, so an app opens these pages in the system browser.
 */
export function cloudComputerWebsite(
  portalOrigin: string,
  page: "checkout" | "billing" | "home",
): string {
  const path =
    page === "checkout"
      ? "/cloud-computer/checkout"
      : page === "billing"
        ? "/cloud-computer/billing"
        : "/cloud-computer";
  return new URL(path, portalOrigin).toString();
}

/** The typed word that confirms a delete, and what the Account takes for it. */
export function cloudComputerDeleteInput(
  id: CloudComputerView["id"],
  typed: string,
): DesktopCloudComputerActInput | null {
  return typed.trim().toLowerCase() === cloudWords("cloud.delete.word")
    ? { action: "delete", id, confirmation: cloudComputerDeleteConfirmation(id) }
    : null;
}

/** Which kind of Home this is, for where a Cloud Computer is offered. */
export type CloudComputerHomeKind = "mac" | "server" | "cloud";

export function cloudComputerHomeKind(input: {
  readonly exposure: "loopback" | "networked" | undefined;
  readonly publicOrigin: string | undefined;
  /** Addresses of the person's ready Cloud Computers, when known. */
  readonly cloudAddresses: readonly string[];
}): CloudComputerHomeKind {
  if (input.exposure !== "networked") return "mac";
  const origin = input.publicOrigin ? safeOrigin(input.publicOrigin) : null;
  return origin !== null && input.cloudAddresses.some((address) => safeOrigin(address) === origin)
    ? "cloud"
    : "server";
}
function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/** The "Not now" on the asleep suggestion: it comes back after two weeks, no sooner. */
export const cloudSuggestionQuietMs = 14 * 24 * 60 * 60_000;
export function cloudSuggestionAllowed(dismissedAt: number | null, now: number): boolean {
  return dismissedAt === null || now - dismissedAt >= cloudSuggestionQuietMs;
}

/* ------------------------------------------------------------------------- *
 * The store: one read, re-read while something is under way.
 * ------------------------------------------------------------------------- */

export type CloudComputerReadState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly data: CloudComputerListResponse;
      /** Work Homes organizations assigned this person; empty when none or unread. */
      readonly work: readonly DesktopWorkHome[];
    }
  | { readonly kind: "failed"; readonly failure: DesktopCloudComputerFailure };

export interface CloudComputerSnapshot {
  readonly screen: CloudComputerScreen;
  /** The action under way, if one is. */
  readonly pending: DesktopCloudComputerActInput["action"] | null;
  /** The Account's answer to the last action, in its own words. */
  readonly actionFailure: string | null;
  /**
   * Checkout was opened from this app and is still being followed: until the person turns
   * back, or the watch ends after `cloudCheckoutWatchMs`. The one fact every screen that waits
   * on checkout reads.
   */
  readonly checkoutFollowed: boolean;
  /** Each work Home, beside the personal screen; none until a read succeeds. */
  readonly work: readonly WorkHomeCard[];
  /** The Account's views, for saying which kind of Home a Deployment is; null until read. */
  readonly views: {
    readonly computers: readonly CloudComputerView[];
    readonly work: readonly DesktopWorkHome[];
  } | null;
}

export type CloudComputerSchedule = (run: () => void, ms: number) => () => void;
const defaultSchedule: CloudComputerSchedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** How often the status is read again while it is preparing or checkout is open. */
export const cloudComputerPollMs = 5_000;
/** Checkout left open longer than this stops being watched; returning reads again. */
export const cloudCheckoutWatchMs = 30 * 60_000;

export class CloudComputerClient {
  readonly #account: CloudComputerAccount;
  readonly #schedule: CloudComputerSchedule;
  readonly #now: () => number;
  readonly #locale: string | undefined;
  readonly #listeners = new Set<() => void>();
  #read: CloudComputerReadState = { kind: "loading" };
  #checkoutOpenedAt: number | null = null;
  #deleted = false;
  #pending: CloudComputerSnapshot["pending"] = null;
  #actionFailure: string | null = null;
  #snapshot: CloudComputerSnapshot;
  #cancelPoll: (() => void) | null = null;
  #generation = 0;
  #starts = 0;

  constructor(options: {
    readonly account: CloudComputerAccount;
    readonly schedule?: CloudComputerSchedule;
    readonly now?: () => number;
    readonly locale?: string;
  }) {
    this.#account = options.account;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#now = options.now ?? Date.now;
    this.#locale = options.locale;
    this.#snapshot = this.#compute();
  }

  getSnapshot = (): CloudComputerSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** Reads while observed; the last observer leaving stops any re-reading. */
  start(): () => void {
    if (this.#starts++ === 0) void this.refresh();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.#starts === 0) {
        this.#cancelPoll?.();
        this.#cancelPoll = null;
        this.#generation++;
      }
    };
  }

  /** Reads the Account again: on return to the app, after checkout, or on Try again. */
  refresh = async (): Promise<void> => {
    const generation = ++this.#generation;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    const result = await this.#account.read();
    if (generation !== this.#generation) return;
    this.#read = result.ok
      ? { kind: "ready", data: result.data, work: result.work ?? [] }
      : { kind: "failed", failure: result.failure };
    // The watch is over: checkout is no longer followed, and nothing waits on it.
    if (this.#checkoutOpenedAt !== null && !this.#following()) this.#checkoutOpenedAt = null;
    this.#changed();
    if (this.#starts > 0 && this.#watching())
      this.#cancelPoll = this.#schedule(() => void this.refresh(), cloudComputerPollMs);
  };

  /** Checkout opened in the browser: watch for the computer it creates. */
  checkoutOpened = (): void => {
    this.#checkoutOpenedAt = this.#now();
    this.#deleted = false;
    this.#changed();
    void this.refresh();
  };

  /** The person turned back from checkout: stop following it and stop reading for it. */
  stopFollowingCheckout = (): void => {
    if (this.#checkoutOpenedAt === null) return;
    this.#checkoutOpenedAt = null;
    this.#generation++;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    this.#changed();
  };

  act = async (input: DesktopCloudComputerActInput): Promise<boolean> => {
    if (this.#pending !== null) return false;
    this.#pending = input.action;
    this.#actionFailure = null;
    this.#changed();
    const result = await this.#account.act(input);
    this.#pending = null;
    if (!result.ok) {
      this.#actionFailure = result.failure.message;
      this.#changed();
      return false;
    }
    if (this.#read.kind === "ready") {
      const computers = this.#read.data.computers.map((computer) =>
        computer.id === result.data.id ? result.data : computer,
      );
      this.#read = { ...this.#read, data: { ...this.#read.data, computers } };
    }
    if (input.action === "delete") this.#deleted = true;
    this.#changed();
    void this.refresh();
    return true;
  };

  dismissFailure = (): void => {
    this.#actionFailure = null;
    this.#changed();
  };

  #watching(): boolean {
    if (this.#read.kind !== "ready") return false;
    const current = currentCloudComputer(this.#read.data.computers, this.#read.work);
    if (current?.status === "preparing") return true;
    if (this.#read.work.some(({ home }) => home.assignment.homeStatus === "preparing")) return true;
    return current === null && this.#following();
  }

  #following(): boolean {
    return (
      this.#checkoutOpenedAt !== null && this.#now() - this.#checkoutOpenedAt < cloudCheckoutWatchMs
    );
  }

  #compute(): CloudComputerSnapshot {
    return {
      screen: cloudComputerScreen({
        read: this.#read,
        checkoutOpened: this.#following(),
        deleted: this.#deleted,
        ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      }),
      pending: this.#pending,
      actionFailure: this.#actionFailure,
      checkoutFollowed: this.#following(),
      work:
        this.#read.kind === "ready"
          ? this.#read.work.map((work) => workHomeCard(work, this.#locale))
          : [],
      views:
        this.#read.kind === "ready"
          ? { computers: this.#read.data.computers, work: this.#read.work }
          : null,
    };
  }

  #changed(): void {
    this.#snapshot = this.#compute();
    this.#listeners.forEach((listener) => listener());
  }
}
