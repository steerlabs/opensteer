import {
  cloudComputerDeleteConfirmation,
  type CloudComputerListResponse,
  type CloudComputerView,
} from "@opensteer/control-plane-protocol";
import type {
  DesktopCloudComputerActInput,
  DesktopCloudComputerFailure,
} from "@opensteer/protocol/desktop";
import type { CloudComputerAccount } from "../connections/account-cloud-computers.js";
import { cloudWords } from "./cloud-computer-copy.js";

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
  const currency = plan.currency.toUpperCase();
  const format = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  const price = format.format(plan.amountMinor / 10 ** digits);
  return {
    name: plan.name,
    price,
    line: plan.interval
      ? cloudWords("cloud.price", { price, interval: plan.interval })
      : cloudWords("cloud.priceOnce", { price }),
  };
}

/**
 * Facts the design shows that the Account does not report yet. Each is null until it
 * does; a screen never draws a value for one it does not have.
 */
export interface CloudComputerUnreported {
  readonly region: string | null;
  readonly browserIpAddress: string | null;
  readonly lastBackupAt: string | null;
  readonly renewsAt: string | null;
}
const unreported: CloudComputerUnreported = {
  region: null,
  browserIpAddress: null,
  lastBackupAt: null,
  renewsAt: null,
};

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
  readonly canSuspend: boolean;
  readonly canResume: boolean;
  readonly unreported: CloudComputerUnreported;
}

export type CloudComputerScreen =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly failure: DesktopCloudComputerFailure }
  /** None yet: what it is and its price. `waiting` once checkout was opened from here. */
  | {
      readonly kind: "offer";
      readonly plan: CloudComputerPlanView;
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

export function cloudComputerDetail(view: CloudComputerView): CloudComputerDetail {
  const status: CloudComputerStatusView =
    view.status === "ready"
      ? { label: cloudWords("cloud.status.running"), tone: "good", reason: null }
      : view.status === "preparing"
        ? { label: cloudWords("cloud.status.preparing"), tone: "neutral", reason: null }
        : view.status === "suspended"
          ? { label: cloudWords("cloud.status.suspended"), tone: "neutral", reason: view.reason }
          : view.status === "needs_attention"
            ? {
                label: cloudWords("cloud.status.attention"),
                tone: "attention",
                reason: view.reason,
              }
            : { label: cloudWords("cloud.deleted"), tone: "neutral", reason: null };
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
    canSuspend: view.status === "ready" || view.status === "needs_attention",
    canResume: view.status === "suspended",
    unreported,
  };
}

/** The person's one Cloud Computer: the newest that isn't deleted. */
export function currentCloudComputer(
  computers: readonly CloudComputerView[],
): CloudComputerView | null {
  return computers.find((computer) => computer.status !== "deleted") ?? null;
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
  const current = currentCloudComputer(read.data.computers);
  if (current === null)
    return { kind: "offer", plan, waiting: input.checkoutOpened, deleted: input.deleted };
  const computer = cloudComputerDetail(current);
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
  | { readonly kind: "ready"; readonly data: CloudComputerListResponse }
  | { readonly kind: "failed"; readonly failure: DesktopCloudComputerFailure };

export interface CloudComputerSnapshot {
  readonly screen: CloudComputerScreen;
  /** The action under way, if one is. */
  readonly pending: DesktopCloudComputerActInput["action"] | null;
  /** The Account's answer to the last action, in its own words. */
  readonly actionFailure: string | null;
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
      ? { kind: "ready", data: result.data }
      : { kind: "failed", failure: result.failure };
    if (result.ok && currentCloudComputer(result.data.computers)) this.#checkoutOpenedAt = null;
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
      this.#read = { kind: "ready", data: { ...this.#read.data, computers } };
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
    const current = currentCloudComputer(this.#read.data.computers);
    if (current?.status === "preparing") return true;
    return (
      current === null &&
      this.#checkoutOpenedAt !== null &&
      this.#now() - this.#checkoutOpenedAt < cloudCheckoutWatchMs
    );
  }

  #compute(): CloudComputerSnapshot {
    return {
      screen: cloudComputerScreen({
        read: this.#read,
        checkoutOpened: this.#checkoutOpenedAt !== null,
        deleted: this.#deleted,
        ...(this.#locale === undefined ? {} : { locale: this.#locale }),
      }),
      pending: this.#pending,
      actionFailure: this.#actionFailure,
    };
  }

  #changed(): void {
    this.#snapshot = this.#compute();
    this.#listeners.forEach((listener) => listener());
  }
}
