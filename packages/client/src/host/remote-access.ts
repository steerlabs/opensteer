import type {
  PersonalRemoteAdministrationIntent,
  PersonalRemoteAdministrationOperation,
  PersonalRemoteAdministrationStatus,
} from "@opensteer/protocol";
import type { DesktopPersonalAccountLinkStatus } from "@opensteer/protocol/desktop";
import { HostClientRequestError } from "./client.js";
import { remoteAccessDisconnectWarning } from "./personal-remote-access.js";

/**
 * "Use from anywhere": what to show and what to do next, for every surface.
 *
 * `remoteAccessView` is the whole presentation, read from live state each
 * time, so web, desktop and mobile say the same words. `RemoteAccessRunner`
 * runs only the steps a change still needs, skipping what is already true.
 * The Host carries every change it accepted: the runner never waits on one,
 * and the view reads its progress and outcome from the Host.
 */

/** The Account link as the computer's own app sees it; absent where only the Host is known. */
export type RemoteAccessLink = DesktopPersonalAccountLinkStatus["status"];

export interface RemoteAccessFacts {
  readonly status: PersonalRemoteAdministrationStatus | null;
  /** The status read failed: not this person's to change, or the computer is away. */
  readonly statusUnreadable: boolean;
  readonly link: RemoteAccessLink | null;
  /** Whether this device is signed in to the Opensteer account; null where linking signs in itself. */
  readonly signedIn: boolean | null;
  readonly computerName: string | null;
}

/**
 * The platform's half of turning this on, bound to one computer. Each call
 * rejects with a sentence a person can read.
 */
export interface RemoteAccessPort {
  readonly signIn?: (signal: AbortSignal) => Promise<void>;
  /**
   * Adds this computer to the signed-in account. With `activating`, finishes
   * the link the computer already holds; a fresh link would be refused.
   */
  readonly link: (input: {
    readonly activating: boolean;
    readonly signal: AbortSignal;
  }) => Promise<void>;
  /** Present only where a link can need repair (the computer's own app). */
  readonly repair?: (signal: AbortSignal) => Promise<void>;
}

export type RemoteAccessGoal =
  | "turn-on"
  | "turn-off"
  | "reset-key"
  | "remove-link"
  | "finish-adding"
  | "repair-link"
  | "recover";

export type RemoteAccessRunStep = "checking" | "sign-in" | "link" | "resume" | "repair" | "request";

export type RemoteAccessRunState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "running";
      readonly goal: RemoteAccessGoal;
      readonly step: RemoteAccessRunStep;
    }
  | { readonly kind: "failed"; readonly goal: RemoteAccessGoal; readonly message: string };

export type RemoteAccessState =
  | "loading"
  | "unreadable"
  | "connect-unavailable"
  | "off"
  | "off-signed-out"
  | "turning-on"
  | "turning-off"
  | "resetting-key"
  | "removing-link"
  | "waiting-for-app"
  | "on-connect"
  | "on-private"
  | "turn-on-failed"
  | "change-failed"
  | "link-activating"
  | "link-needs-repair"
  | "linked-elsewhere";

export type RemoteAccessActionId =
  | "turn-on"
  | "turn-off"
  | "cancel"
  | "try-again"
  | "finish-adding"
  | "repair-link"
  | "remove-link"
  | "reset-key"
  | "add-device";

export interface RemoteAccessAction {
  readonly id: RemoteAccessActionId;
  readonly label: string;
  /** Ask this before acting: the change signs devices out. */
  readonly confirm: string | null;
}

export interface RemoteAccessStep {
  readonly label: string;
  readonly state: "done" | "active" | "todo";
}

export interface RemoteAccessView {
  readonly state: RemoteAccessState;
  readonly tone: "neutral" | "busy" | "on" | "attention";
  /** One or two words: the status. */
  readonly title: string;
  readonly sentence: string;
  /** Whether remote access is configured on; a switch shows this. */
  readonly on: boolean;
  readonly primary: RemoteAccessAction | null;
  readonly secondary: readonly RemoteAccessAction[];
  readonly steps: readonly RemoteAccessStep[] | null;
  /** The address it is reachable at, when on. */
  readonly address: string | null;
}

const idle: RemoteAccessRunState = { kind: "idle" };
const somethingWentWrong = "Something went wrong. Try again.";

const action = (
  id: RemoteAccessActionId,
  label: string,
  confirm: string | null = null,
): RemoteAccessAction => ({ id, label, confirm });
const turnOn = action("turn-on", "Turn on");
const turnOff = action("turn-off", "Turn off", remoteAccessDisconnectWarning);
const cancel = action("cancel", "Cancel");
const tryAgain = action("try-again", "Try again");

/** The Host's link, sharpened by what the computer's own app knows about it. */
export function remoteAccessLink(facts: RemoteAccessFacts): RemoteAccessLink {
  if (
    facts.link === "linked-elsewhere" ||
    facts.link === "needs-repair" ||
    facts.link === "unlinking"
  )
    return facts.link;
  const link = facts.status?.access.accountLink ?? null;
  return link === null ? "unlinked" : link.state === "active" ? "linked" : "activating";
}

function outstanding(
  operation: PersonalRemoteAdministrationOperation | null,
): operation is PersonalRemoteAdministrationOperation {
  return operation?.state === "pending" || operation?.state === "running";
}

function intentGoal(intent: PersonalRemoteAdministrationOperation["intent"]): RemoteAccessGoal {
  if (intent.action === "configure")
    return intent.mode === "connect" ? "turn-on" : intent.mode === "off" ? "turn-off" : "recover";
  if (intent.action === "rotate") return "reset-key";
  if (intent.action === "unlink") return "remove-link";
  return "recover";
}

function goalIntent(goal: RemoteAccessGoal): PersonalRemoteAdministrationIntent | null {
  switch (goal) {
    case "turn-on":
      return { action: "configure", mode: "connect", privateOrigin: null };
    case "turn-off":
      return { action: "configure", mode: "off", privateOrigin: null };
    case "reset-key":
      return { action: "rotate" };
    case "remove-link":
      return { action: "unlink" };
    case "recover":
      return { action: "recover" };
    default:
      return null;
  }
}

function sameIntent(
  left: PersonalRemoteAdministrationOperation["intent"],
  right: PersonalRemoteAdministrationIntent,
): boolean {
  if (left.action !== right.action) return false;
  return left.action !== "configure" || (right.action === "configure" && left.mode === right.mode);
}

/** A failed change that still says something true about the computer now. */
function standingFailure(
  status: PersonalRemoteAdministrationStatus,
): PersonalRemoteAdministrationOperation | null {
  const operation = status.operation;
  if (operation?.state !== "failed") return null;
  const { intent } = operation;
  const { access } = status;
  if (intent.action === "configure") return access.mode === intent.mode ? null : operation;
  if (intent.action === "rotate") return access.mode === "connect" ? operation : null;
  if (intent.action === "unlink") return access.accountLink === null ? null : operation;
  return operation;
}

/** What `goal` needs next, from live state; `done` once nothing is left for this device. */
export function nextRemoteAccessStep(
  goal: RemoteAccessGoal,
  facts: RemoteAccessFacts,
  port: Pick<RemoteAccessPort, "repair" | "signIn">,
):
  | { readonly kind: "done" }
  | { readonly kind: "checking" }
  | { readonly kind: "blocked"; readonly message: string }
  | { readonly kind: "sign-in" | "link" | "resume" | "repair" }
  | { readonly kind: "request"; readonly intent: PersonalRemoteAdministrationIntent } {
  const { status } = facts;
  if (!status)
    return facts.statusUnreadable
      ? { kind: "blocked", message: unreadableSentence }
      : { kind: "checking" };
  const link = remoteAccessLink(facts);
  const name = computerName(facts);
  // Any change the Host already holds is carried by the Host, whoever asked
  // for it: an equivalent one is this goal in progress, and anything else
  // must finish (or be turned off) first.
  if (outstanding(status.operation) && goal !== "turn-off") return { kind: "done" };
  if (goal === "repair-link") {
    if (link !== "needs-repair") return { kind: "done" };
    return port.repair ? { kind: "repair" } : { kind: "blocked", message: repairSentence(name) };
  }
  if (goal === "turn-on" || goal === "finish-adding") {
    if (goal === "turn-on" && status.access.mode === "connect") return { kind: "done" };
    if (goal === "turn-on" && status.accountIssuer === null)
      return { kind: "blocked", message: connectUnavailableSentence };
    if (link === "linked-elsewhere") return { kind: "blocked", message: elsewhereSentence(name) };
    if (link === "needs-repair") return { kind: "blocked", message: repairSentence(name) };
    if (link === "unlinking") return { kind: "done" };
    if (link === "activating") return { kind: "resume" };
    if (link === "unlinked") {
      if (goal === "finish-adding") return { kind: "done" };
      return facts.signedIn === false && port.signIn ? { kind: "sign-in" } : { kind: "link" };
    }
    if (goal === "finish-adding") return { kind: "done" };
  }
  if (goal === "turn-off" && status.access.mode === "off" && !outstanding(status.operation))
    return { kind: "done" };
  if (goal === "turn-off" && outstanding(status.operation)) {
    const { intent } = status.operation;
    if (intent.action === "configure" && intent.mode === "off") return { kind: "done" };
  }
  if (goal === "remove-link" && status.access.accountLink === null && link !== "linked-elsewhere")
    return { kind: "done" };
  const intent = goalIntent(goal);
  if (!intent) return { kind: "done" };
  // Trying a failed change again keeps its identity, so a retried key reset
  // or Connect setup is the same change to the Account, not a second one.
  const failed = status.operation?.state === "failed" ? status.operation : null;
  return {
    kind: "request",
    intent:
      failed && (goal === "recover" || sameIntent(failed.intent, intent))
        ? { action: "recover" }
        : intent,
  };
}

function computerName(facts: Pick<RemoteAccessFacts, "computerName">): string {
  return facts.computerName?.trim() || "this computer";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const unreadableSentence = "Couldn’t check this right now. Try again in a moment.";
const connectUnavailableSentence =
  "Opening Opensteer from anywhere isn’t available in this version. You can use a private network instead, in Advanced.";
const elsewhereSentence = (name: string) =>
  `${capitalized(name)} is in a different Opensteer account. Remove the link to add it to yours.`;
const repairSentence = (name: string) =>
  `${capitalized(name)}’s link to your account needs repair before this can turn on.`;

function stepFailureSentence(step: RemoteAccessRunStep, name: string): string {
  switch (step) {
    case "sign-in":
      return "Signing in didn’t finish. Try again.";
    case "link":
    case "resume":
      return `Couldn’t add ${name} to your account. Try again.`;
    case "repair":
      return `Couldn’t repair ${name}’s link to your account. Try again.`;
    default:
      return somethingWentWrong;
  }
}

/** The sentence a failure shows: the Host's or the port's own words, never a raw fault. */
export function remoteAccessFailureMessage(error: unknown): string {
  if (error instanceof HostClientRequestError) return error.message;
  if (error instanceof RemoteAccessPortError) return error.message;
  return somethingWentWrong;
}

/** A port failure whose message is already written for a person. */
export class RemoteAccessPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteAccessPortError";
  }
}

function turnOnSteps(facts: RemoteAccessFacts, name: string): readonly RemoteAccessStep[] {
  const link = remoteAccessLink(facts);
  const linked = link === "linked";
  const done = [
    ...(facts.signedIn === null
      ? []
      : [{ label: "Sign in to your Opensteer account", done: linked || facts.signedIn === true }]),
    { label: `Add ${name} to your account`, done: linked },
    { label: "Turn on the connection", done: facts.status?.access.mode === "connect" },
  ];
  const active = done.findIndex((step) => !step.done);
  return done.map((step, index) => ({
    label: step.label,
    state: step.done ? "done" : index === active ? "active" : "todo",
  }));
}

function view(
  state: RemoteAccessState,
  tone: RemoteAccessView["tone"],
  title: string,
  sentence: string,
  options: Partial<
    Pick<RemoteAccessView, "address" | "on" | "primary" | "secondary" | "steps">
  > = {},
): RemoteAccessView {
  return {
    address: options.address ?? null,
    on: options.on ?? false,
    primary: options.primary ?? null,
    secondary: options.secondary ?? [],
    state,
    steps: options.steps ?? null,
    sentence,
    title,
    tone,
  };
}

/** The one status, sentence and action every surface shows. */
export function remoteAccessView(
  facts: RemoteAccessFacts,
  run: RemoteAccessRunState = idle,
): RemoteAccessView {
  const { status } = facts;
  const name = computerName(facts);
  const Name = capitalized(name);
  if (!status)
    return facts.statusUnreadable
      ? view("unreadable", "attention", "Can’t check", unreadableSentence)
      : view("loading", "neutral", "Checking…", `Checking how ${name} can be opened.`);
  const { access } = status;
  const on = access.mode !== "off";
  const address = access.route?.document.route.origin ?? null;
  const link = remoteAccessLink(facts);
  const operation = status.operation;
  // While on, Off is always one tap away; while turning on, Cancel is.
  const stopping = on ? [turnOff] : [];

  const busy = (goal: RemoteAccessGoal, detail: string | null): RemoteAccessView => {
    switch (goal) {
      case "turn-off":
        return view(
          "turning-off",
          "busy",
          "Turning off…",
          `${Name} will stop opening from anywhere.`,
          { on },
        );
      case "reset-key":
        return view(
          "resetting-key",
          "busy",
          "Resetting…",
          detail ?? "Resetting the connection key…",
          {
            address,
            on,
            secondary: stopping,
          },
        );
      case "remove-link":
        return view(
          "removing-link",
          "busy",
          "Removing…",
          `Removing ${name} from your Opensteer account…`,
          {
            on,
            secondary: stopping,
          },
        );
      default: {
        const step = run.kind === "running" ? run.step : null;
        const linking =
          step === "link" ||
          step === "resume" ||
          step === "repair" ||
          (goal !== "recover" && remoteAccessLink(facts) !== "linked");
        const sentence =
          step === "sign-in"
            ? "Finish signing in to your Opensteer account."
            : linking
              ? `Adding ${name} to your account…`
              : (detail ?? "Setting up the connection…");
        return view("turning-on", "busy", "Turning on…", sentence, {
          on,
          secondary: [cancel],
          steps: goal === "turn-on" ? turnOnSteps(facts, name) : null,
        });
      }
    }
  };

  if (outstanding(operation)) {
    if (!status.executorConnected)
      return view(
        "waiting-for-app",
        "busy",
        "Waiting",
        `Open Opensteer on ${name} to finish this change.`,
        { on, secondary: [cancel] },
      );
    return busy(intentGoal(operation.intent), operation.detail);
  }
  if (run.kind === "running" && run.step !== "checking") return busy(run.goal, null);

  const failure = (goal: RemoteAccessGoal, message: string): RemoteAccessView => {
    if (goal === "turn-on" || (goal === "recover" && !on) || goal === "finish-adding")
      return view("turn-on-failed", "attention", "Couldn’t turn on", message, {
        primary: tryAgain,
      });
    const title =
      goal === "turn-off"
        ? "Couldn’t turn off"
        : goal === "reset-key"
          ? "Couldn’t reset"
          : goal === "remove-link"
            ? "Couldn’t remove"
            : goal === "repair-link"
              ? "Couldn’t repair"
              : "Couldn’t finish";
    return view(
      "change-failed",
      "attention",
      title,
      on ? `${message} ${Name} can still be opened from anywhere.` : message,
      { address, on, primary: tryAgain, secondary: goal === "turn-off" ? [] : stopping },
    );
  };
  if (run.kind === "failed") return failure(run.goal, run.message);
  const failed = standingFailure(status);
  if (failed) return failure(intentGoal(failed.intent), failed.detail ?? somethingWentWrong);

  const removeLink = action("remove-link", "Remove from account", remoteAccessDisconnectWarning);
  if (access.mode === "connect")
    return view(
      "on-connect",
      "on",
      "On",
      `Your phone and signed-in computers can open ${name} from anywhere.`,
      {
        address,
        on,
        primary: turnOff,
        secondary: [
          action("reset-key", "Reset connection key", remoteAccessDisconnectWarning),
          removeLink,
        ],
      },
    );
  if (access.mode === "private")
    return view(
      "on-private",
      "on",
      "On",
      `Devices on your private network can open ${name} at this address.`,
      { address, on, primary: action("add-device", "Add a device"), secondary: [turnOff] },
    );
  if (link === "linked-elsewhere")
    return view("linked-elsewhere", "attention", "Another account", elsewhereSentence(name), {
      primary: action("remove-link", "Remove link", remoteAccessDisconnectWarning),
    });
  if (link === "needs-repair")
    return view("link-needs-repair", "attention", "Needs repair", repairSentence(name), {
      primary: action("repair-link", "Repair"),
    });
  if (link === "activating")
    return view(
      "link-activating",
      "attention",
      "Almost done",
      `${Name} is saved to your account but not added yet.`,
      {
        primary: action("finish-adding", "Finish adding"),
        secondary: [action("remove-link", "Remove")],
      },
    );
  if (status.accountIssuer === null)
    return view("connect-unavailable", "neutral", "Off", connectUnavailableSentence);
  if (facts.signedIn === false && link !== "linked")
    return view(
      "off-signed-out",
      "neutral",
      "Off",
      `Only ${name} can use Opensteer. Turning this on asks you to sign in first.`,
      { primary: turnOn },
    );
  return view("off", "neutral", "Off", `Only ${name} can use Opensteer.`, { primary: turnOn });
}

/** The goal a view action starts, given the state it was offered in. */
export function remoteAccessActionGoal(
  id: RemoteAccessActionId,
  facts: RemoteAccessFacts,
  run: RemoteAccessRunState,
): RemoteAccessGoal | null {
  switch (id) {
    case "turn-on":
      return "turn-on";
    case "turn-off":
    case "cancel":
      return "turn-off";
    case "reset-key":
      return "reset-key";
    case "remove-link":
      return "remove-link";
    case "finish-adding":
      return "finish-adding";
    case "repair-link":
      return "repair-link";
    case "try-again": {
      if (run.kind === "failed") return run.goal;
      const failed = facts.status ? standingFailure(facts.status) : null;
      return failed ? intentGoal(failed.intent) : null;
    }
    case "add-device":
      return null;
  }
}

/** How long a step may take to show up in the state this runner reads. */
const settleMilliseconds = 2 * 60_000;

/**
 * Runs one goal's missing steps. Every await is followed by an abort check, so
 * stopping (or starting another goal) ends the steps not yet sent; a change
 * the Host already accepted is the Host's to finish and is never presented as
 * cancelled.
 */
export class RemoteAccessRunner {
  #port: RemoteAccessPort;
  readonly #request: (
    intent: PersonalRemoteAdministrationIntent,
  ) => Promise<PersonalRemoteAdministrationOperation>;
  readonly #settleMilliseconds: number;
  readonly #listeners = new Set<() => void>();
  readonly #waiters = new Set<() => void>();
  #facts: RemoteAccessFacts;
  #state: RemoteAccessRunState = idle;
  #run: AbortController | null = null;

  constructor(options: {
    readonly facts: RemoteAccessFacts;
    readonly port: RemoteAccessPort;
    readonly request: (
      intent: PersonalRemoteAdministrationIntent,
    ) => Promise<PersonalRemoteAdministrationOperation>;
    readonly settleMilliseconds?: number;
  }) {
    this.#facts = options.facts;
    this.#port = options.port;
    this.#request = options.request;
    this.#settleMilliseconds = options.settleMilliseconds ?? settleMilliseconds;
  }

  getSnapshot = (): RemoteAccessRunState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Feeds live state (and the current port); waiting steps re-check on every call. */
  update(facts: RemoteAccessFacts, port: RemoteAccessPort = this.#port): void {
    this.#facts = facts;
    this.#port = port;
    // A failure stops standing once what it tried is true anyway.
    if (
      this.#state.kind === "failed" &&
      nextRemoteAccessStep(this.#state.goal, facts, this.#port).kind === "done"
    )
      this.#set(idle);
    for (const waiter of this.#waiters) waiter();
  }

  start(goal: RemoteAccessGoal): void {
    this.#run?.abort();
    const controller = new AbortController();
    this.#run = controller;
    void this.#execute(goal, controller.signal);
  }

  /** Ends the steps not yet sent. */
  stop(): void {
    this.#run?.abort();
    this.#run = null;
    this.#set(idle);
  }

  async #execute(goal: RemoteAccessGoal, signal: AbortSignal): Promise<void> {
    const tried = new Set<RemoteAccessRunStep>();
    let step: RemoteAccessRunStep = "checking";
    try {
      for (;;) {
        const next = nextRemoteAccessStep(goal, this.#facts, this.#port);
        if (next.kind === "done") break;
        if (next.kind === "blocked") throw new RemoteAccessPortError(next.message);
        step = next.kind;
        this.#set({ kind: "running", goal, step });
        if (next.kind === "checking") {
          await this.#until(
            () => this.#facts.status !== null || this.#facts.statusUnreadable,
            signal,
          );
          continue;
        }
        // A step that is still missing after it ran will not appear by
        // running it again; the person is told instead of looping.
        if (tried.has(next.kind))
          throw new RemoteAccessPortError(
            stepFailureSentence(next.kind, computerName(this.#facts)),
          );
        tried.add(next.kind);
        if (next.kind === "request") {
          const before = this.#facts.status?.operation?.id ?? null;
          await this.#request(next.intent);
          signal.throwIfAborted();
          // Busy until the Host's own state shows the change, so the view
          // never flashes back to what it was before.
          await this.#until(
            () =>
              (this.#facts.status?.operation?.id ?? null) !== before ||
              nextRemoteAccessStep(goal, this.#facts, this.#port).kind === "done",
            signal,
          ).catch(() => signal.throwIfAborted());
          break;
        }
        if (next.kind === "sign-in") {
          await this.#port.signIn?.(signal);
          signal.throwIfAborted();
          await this.#until(
            () => this.#facts.signedIn !== false || remoteAccessLink(this.#facts) === "linked",
            signal,
          );
        } else if (next.kind === "repair") {
          await this.#port.repair?.(signal);
          signal.throwIfAborted();
          await this.#until(() => remoteAccessLink(this.#facts) !== "needs-repair", signal);
        } else {
          const from = remoteAccessLink(this.#facts);
          await this.#port.link({ activating: next.kind === "resume", signal });
          signal.throwIfAborted();
          await this.#until(() => remoteAccessLink(this.#facts) !== from, signal);
        }
      }
      if (!signal.aborted) this.#set(idle);
    } catch (error) {
      if (signal.aborted) return;
      this.#set({
        kind: "failed",
        goal,
        message:
          step === "request" || error instanceof RemoteAccessPortError
            ? remoteAccessFailureMessage(error)
            : stepFailureSentence(step, computerName(this.#facts)),
      });
    } finally {
      if (this.#run?.signal === signal) this.#run = null;
    }
  }

  #until(ready: () => boolean, signal: AbortSignal): Promise<void> {
    if (ready()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", aborted);
        this.#waiters.delete(check);
        settle();
      };
      const check = () => {
        if (ready()) finish(resolve);
      };
      const aborted = () => finish(() => reject(signal.reason));
      const timer = setTimeout(
        () => finish(() => reject(new Error("The step never showed up in the computer's state."))),
        this.#settleMilliseconds,
      );
      signal.addEventListener("abort", aborted, { once: true });
      this.#waiters.add(check);
    });
  }

  #set(state: RemoteAccessRunState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
