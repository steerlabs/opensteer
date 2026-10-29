import type { IntegrationAccess } from "@opensteer/integration-core";
import {
  computerUseDataApps,
  type ComputerUseDataAppId,
  type ComputerUseDataGrant,
  type ComputerUseDataGrants,
} from "@opensteer/protocol";
import type {
  DesktopComputerAppSetup,
  DesktopComputerAppSetupStatus,
  DesktopComputerAppSetupStep,
} from "@opensteer/protocol/desktop";

/**
 * Each data grant's Privacy pane, named as macOS names it. They are
 * main-process constants for the same reason the computer-use panes are: a
 * renderer that could name an `x-apple.systempreferences:` target would hold
 * a general way to launch system panes.
 */
export const dataGrantSettingsUrls: Readonly<Record<ComputerUseDataGrant, string>> = {
  automation:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation",
  calendars:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars",
  contacts:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Contacts",
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
  reminders:
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Reminders",
};

/** How long an agent's failed call stays quiet after the person said not now. */
export const computerAppSetupAgentQuietMs = 30 * 60_000;
/** This app's own Full Disk Access is a child process, so it is asked sparingly. */
const ownFullDiskAccessIntervalMs = 3_000;
/**
 * How often a helper that still cannot read is asked to look again with a
 * fresh process while the person is on the Full Disk Access step. macOS gives
 * the grant to a process from its next launch; the helper's own check of a
 * child usually finds it within a second, and this is what finds it if not.
 */
const freshLookIntervalMs = 10_000;
/** A restarting helper is gone for a moment; only a longer gap is shown. */
const unreachableAfterMs = 3_000;

/** The Mac app each helper-served definition reads, as the panel draws it. */
const targetApps: Readonly<
  Record<ComputerUseDataAppId, { readonly bundleId: string; readonly name: string }>
> = {
  "apple-calendar": { bundleId: "com.apple.iCal", name: "Calendar" },
  "apple-contacts": { bundleId: "com.apple.AddressBook", name: "Contacts" },
  "apple-messages": { bundleId: "com.apple.MobileSMS", name: "Messages" },
  "apple-reminders": { bundleId: "com.apple.reminders", name: "Reminders" },
};

export interface ComputerAppSetupGuideOptions {
  /** The helper's 64×64 icon for one app, base64 PNG, or null. */
  readonly appIcon: (bundleId: string) => Promise<string | null>;
  /** This app's name as macOS lists it: "Opensteer" or "Opensteer Beta". */
  readonly appName: string;
  /** The helper's grants, read without prompting. */
  readonly dataGrants: () => Promise<ComputerUseDataGrants>;
  /** The installed helper bundle, the one thing a drag may carry. */
  readonly helperAppPath: string;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  readonly now?: () => number;
  /** Opens one grant's Privacy pane; the URLs are main's own constants. */
  readonly openSettings: (grant: ComputerUseDataGrant) => Promise<void>;
  /** Whether this app's own process tree has Full Disk Access. */
  readonly ownFullDiskAccess: () => Promise<boolean>;
  /** The floating window the steps are drawn in. */
  readonly panel: { open(): Promise<void>; close(): void };
  /** Asks macOS through the helper; may take as long as the person does. */
  readonly requestDataGrant: (grant: ComputerUseDataGrant) => Promise<ComputerUseDataGrants>;
}

interface Step {
  readonly grant: ComputerUseDataGrant;
  kind: "settings" | "ask";
  state: "waiting" | "current" | "done";
}

interface Setup {
  readonly definitionId: ComputerUseDataAppId;
  access: IntegrationAccess;
  phase: "offer" | "steps" | "done";
  readonly steps: Step[];
  unreachableSince: number | null;
  icon: Promise<string | null> | null;
  /** Each step's side effect, once: a pane opened or a question asked. */
  readonly entered: Set<string>;
  /** When the helper last looked at Full Disk Access with a fresh process. */
  freshLookAt: number;
}

interface Waiting {
  readonly definitionId: ComputerUseDataAppId;
  access: IntegrationAccess;
  offer: boolean;
}

/**
 * Setting up an app the helper serves, on this Mac: one panel, one app at a
 * time, every macOS step in it.
 *
 * Nothing here ends setup but the person or success. A question macOS takes
 * longer to have answered than any request deadline is still the step, and
 * the next status read that finds the answer moves on; the pane a switch is
 * in opens once per step, never again unasked. Reading comes first, because
 * that is what the person asked an agent to do.
 *
 * The panel polls `status()`, which is where progress is read; main never
 * has to remember to look.
 */
export class ComputerAppSetupGuide {
  readonly #options: ComputerAppSetupGuideOptions;
  readonly #now: () => number;
  #current: Setup | null = null;
  #queue: Waiting[] = [];
  /**
   * Apps whose first grant read is on its way. Reserved before that read, so
   * a second caller for the same app merges into it rather than starting it
   * twice.
   */
  readonly #pending = new Map<ComputerUseDataAppId, Waiting>();
  readonly #quietUntil = new Map<ComputerUseDataAppId, number>();
  #ownFullDiskAccess: { readonly at: number; readonly value: boolean } | null = null;
  #closed = false;

  constructor(options: ComputerAppSetupGuideOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * The person asked to set this app up. Opens the panel now, or after the
   * app it is showing; an offer already up or on its way for this app becomes
   * the steps, and a request for more access widens whatever is there.
   */
  async open(input: {
    readonly definitionId: ComputerUseDataAppId;
    readonly access: IntegrationAccess;
  }): Promise<{ readonly opened: boolean }> {
    if (this.#closed) return { opened: false };
    const current = this.#current;
    if (current?.definitionId === input.definitionId) {
      if (wider(input.access, current.access)) {
        try {
          await this.#widen(current, input.access);
        } catch (error) {
          // The narrower access stays, so asking again tries again.
          this.#fail("widen", current.definitionId, error);
        }
      }
      if (this.#current !== current) return { opened: false };
      if (current.phase === "offer") await this.begin();
      else await this.#options.panel.open();
      return { opened: true };
    }
    const waiting = this.#waitingFor(input.definitionId);
    if (waiting) {
      if (wider(input.access, waiting.access)) waiting.access = input.access;
      waiting.offer = false;
      return { opened: true };
    }
    return { opened: await this.#start({ ...input, offer: false }) };
  }

  /**
   * An agent's call found a grant missing. The person is offered setup on
   * this Mac — once, and not again for this app for a while after they say
   * not now. A helper that cannot say what is missing offers nothing.
   */
  offerForAgent(input: {
    readonly definitionId: ComputerUseDataAppId;
    readonly access: IntegrationAccess;
  }): void {
    if (this.#closed) return;
    if ((this.#quietUntil.get(input.definitionId) ?? 0) > this.#now()) return;
    const current = this.#current;
    if (current?.definitionId === input.definitionId) {
      if (wider(input.access, current.access)) {
        void this.#widen(current, input.access).catch((error: unknown) =>
          this.#fail("widen", input.definitionId, error),
        );
      }
      return;
    }
    const waiting = this.#waitingFor(input.definitionId);
    if (waiting) {
      if (wider(input.access, waiting.access)) waiting.access = input.access;
      return;
    }
    void this.#start({ ...input, offer: true }).catch((error: unknown) =>
      this.#fail("offer", input.definitionId, error),
    );
  }

  /**
   * The person chose Set up on the offer. The panel names the app it showed,
   * so a Set up that arrives after another app's offer replaced it begins
   * nothing.
   */
  async begin(input?: { readonly definitionId: ComputerUseDataAppId }): Promise<void> {
    const setup = this.#current;
    if (!setup || setup.phase !== "offer") return;
    if (input && input.definitionId !== setup.definitionId) return;
    setup.phase = "steps";
    await this.#refresh(setup);
  }

  /** What the panel draws, read fresh each time it asks. */
  async status(): Promise<DesktopComputerAppSetupStatus> {
    const setup = this.#current;
    if (!setup) return { setup: null };
    await this.#refresh(setup);
    if (this.#current !== setup) return this.status();
    const [thisAppHasFullDiskAccess, appIconPng] = await Promise.all([
      this.#readOwnFullDiskAccess(),
      this.#icon(setup),
    ]);
    // Another app may be showing by now; the panel draws that one.
    if (this.#current !== setup) return this.status();
    return { setup: this.#present(setup, thisAppHasFullDiskAccess, appIconPng) };
  }

  /**
   * The person asked to see the step again: the pane opened again, or the
   * question asked again, which the helper joins to the one on screen.
   */
  async openSettings(): Promise<void> {
    const step = this.#currentStep();
    if (!step) return;
    if (step.kind === "settings") await this.#options.openSettings(step.grant);
    else this.#ask(this.#current, step.grant);
  }

  /** What the panel's row drags into System Settings, if this step takes one. */
  dragItem(): { readonly file: string } | null {
    const step = this.#currentStep();
    return step?.kind === "settings" && step.grant === "full-disk-access"
      ? { file: this.#options.helperAppPath }
      : null;
  }

  /**
   * The panel closes: finished, or not now. The panel names the app it was
   * showing, so a close that arrives after another app replaced it closes
   * nothing; the window going away by itself names none. Not now keeps
   * agents' offers for this app quiet for a while; the next app waiting opens
   * either way.
   */
  async dismiss(input?: { readonly definitionId: ComputerUseDataAppId }): Promise<void> {
    const setup = this.#current;
    if (!setup || (input && input.definitionId !== setup.definitionId)) return;
    if (setup.phase !== "done") {
      this.#quietUntil.set(setup.definitionId, this.#now() + computerAppSetupAgentQuietMs);
    }
    this.#current = null;
    await this.#next();
  }

  /** Opensteer is quitting: nothing more opens. */
  close(): void {
    this.#closed = true;
    this.#current = null;
    this.#queue = [];
    this.#options.panel.close();
  }

  #waitingFor(definitionId: ComputerUseDataAppId): Waiting | undefined {
    return (
      this.#queue.find((waiting) => waiting.definitionId === definitionId) ??
      this.#pending.get(definitionId)
    );
  }

  /**
   * Reads what the app still needs, then shows it, or queues it behind the
   * app showing. What other callers merged into it while the read was on its
   * way is what is shown.
   */
  async #start(waiting: Waiting): Promise<boolean> {
    this.#pending.set(waiting.definitionId, waiting);
    let grants: ComputerUseDataGrants;
    try {
      grants = await this.#options.dataGrants();
    } finally {
      this.#pending.delete(waiting.definitionId);
    }
    if (this.#closed) return false;
    if (missingSteps(waiting.definitionId, waiting.access, grants).length === 0) return false;
    if (this.#current) {
      this.#queue.push(waiting);
      return true;
    }
    return this.#activate(waiting, grants);
  }

  async #next(): Promise<void> {
    while (!this.#closed && !this.#current) {
      const waiting = this.#queue.shift();
      if (!waiting) {
        this.#options.panel.close();
        return;
      }
      this.#pending.set(waiting.definitionId, waiting);
      let grants: ComputerUseDataGrants;
      try {
        grants = await this.#options.dataGrants();
      } catch (error) {
        this.#fail("next", waiting.definitionId, error);
        continue;
      } finally {
        this.#pending.delete(waiting.definitionId);
      }
      if (this.#closed) return;
      // Somebody opened an app while this read was on its way; this one waits
      // its turn again.
      if (this.#current) {
        this.#queue.unshift(waiting);
        return;
      }
      if (missingSteps(waiting.definitionId, waiting.access, grants).length === 0) continue;
      await this.#activate(waiting, grants);
    }
  }

  async #activate(waiting: Waiting, grants: ComputerUseDataGrants): Promise<boolean> {
    const setup: Setup = {
      access: waiting.access,
      definitionId: waiting.definitionId,
      entered: new Set(),
      freshLookAt: this.#now(),
      icon: null,
      phase: waiting.offer ? "offer" : "steps",
      steps: missingSteps(waiting.definitionId, waiting.access, grants).map((step) => ({
        ...step,
        state: "waiting" as const,
      })),
      unreachableSince: null,
    };
    this.#current = setup;
    if (setup.phase === "steps") this.#advance(setup, grants);
    try {
      await this.#options.panel.open();
    } catch (error) {
      // Without its window nobody can finish it; the app stays as it was.
      this.#fail("panel", setup.definitionId, error);
      if (this.#current === setup) this.#current = null;
      return false;
    }
    // Quitting while the window loaded: it goes with everything else.
    if (this.#closed) {
      this.#options.panel.close();
      return false;
    }
    return this.#current === setup;
  }

  /** One grant read for this setup, applied only if it is still the one showing. */
  async #refresh(setup: Setup): Promise<void> {
    try {
      const grants = await this.#options.dataGrants();
      if (this.#current !== setup || this.#closed) return;
      setup.unreachableSince = null;
      this.#advance(setup, grants);
    } catch {
      // The next status read takes the step once the helper answers.
      if (this.#current === setup) setup.unreachableSince ??= this.#now();
    }
  }

  /**
   * Steps for access widened while this app is showing. The access changes
   * only once the read for it succeeded, so a failed read leaves it to retry.
   */
  async #widen(setup: Setup, access: IntegrationAccess): Promise<void> {
    const grants = await this.#options.dataGrants();
    if (this.#current !== setup || this.#closed || !wider(access, setup.access)) return;
    setup.access = access;
    const known = new Set(setup.steps.map(({ grant }) => grant));
    for (const step of missingSteps(setup.definitionId, setup.access, grants)) {
      if (!known.has(step.grant)) setup.steps.push({ ...step, state: "waiting" });
    }
    if (setup.phase === "done") setup.phase = "steps";
    this.#advance(setup, grants);
  }

  /** Marks what macOS now gives, and takes the first step it does not. */
  #advance(setup: Setup, grants: ComputerUseDataGrants): void {
    for (const step of setup.steps) {
      if (step.state !== "done" && grants[step.grant] === "granted") step.state = "done";
    }
    if (setup.phase !== "steps") {
      if (setup.steps.every(({ state }) => state === "done")) setup.phase = "done";
      return;
    }
    const step = setup.steps.find(({ state }) => state !== "done");
    if (!step) {
      setup.phase = "done";
      return;
    }
    // Refused in macOS's dialog: only System Settings changes it now.
    // (`unknown` is never success: it may be Messages that did not start or an
    // answer macOS is holding, so the step stays and a retry asks again.)
    if (step.kind === "ask" && grants[step.grant] === "denied") step.kind = "settings";
    for (const other of setup.steps) {
      if (other !== step && other.state !== "done") other.state = "waiting";
    }
    step.state = "current";
    this.#enter(setup, step);
    this.#freshLook(setup, step);
  }

  #freshLook(setup: Setup, step: Step): void {
    if (step.kind !== "settings" || step.grant !== "full-disk-access") return;
    if (this.#now() - setup.freshLookAt < freshLookIntervalMs) return;
    setup.freshLookAt = this.#now();
    void this.#options
      .requestDataGrant("full-disk-access")
      .catch((error: unknown) => this.#fail("fresh-look", setup.definitionId, error));
  }

  #enter(setup: Setup, step: Step): void {
    const key = `${step.kind}:${step.grant}`;
    if (setup.entered.has(key)) return;
    setup.entered.add(key);
    if (step.kind === "settings") {
      void this.#options
        .openSettings(step.grant)
        .catch((error: unknown) => this.#fail("settings", setup.definitionId, error));
    } else {
      this.#ask(setup, step.grant);
    }
  }

  #ask(setup: Setup | null, grant: ComputerUseDataGrant): void {
    if (!setup) return;
    // Out of time is not an answer: the question may still be on screen, and
    // the next status read finds out.
    void this.#options
      .requestDataGrant(grant)
      .catch((error: unknown) => this.#fail("ask", setup.definitionId, error));
  }

  #currentStep(): Step | null {
    const setup = this.#current;
    if (!setup || setup.phase !== "steps") return null;
    return setup.steps.find(({ state }) => state === "current") ?? null;
  }

  async #readOwnFullDiskAccess(): Promise<boolean> {
    const cached = this.#ownFullDiskAccess;
    if (cached && this.#now() - cached.at < ownFullDiskAccessIntervalMs) return cached.value;
    let value = false;
    try {
      value = await this.#options.ownFullDiskAccess();
    } catch {
      value = cached?.value ?? false;
    }
    this.#ownFullDiskAccess = { at: this.#now(), value };
    return value;
  }

  #icon(setup: Setup): Promise<string | null> {
    setup.icon ??= this.#options.appIcon(targetApps[setup.definitionId].bundleId).catch(() => null);
    return setup.icon;
  }

  #present(
    setup: Setup,
    thisAppHasFullDiskAccess: boolean,
    appIconPng: string | null,
  ): DesktopComputerAppSetup {
    return {
      appIconPng,
      appName: this.#options.appName,
      definitionId: setup.definitionId,
      helperReachable:
        setup.unreachableSince === null ||
        this.#now() - setup.unreachableSince < unreachableAfterMs,
      phase: setup.phase,
      steps: setup.steps.map(({ grant, kind, state }): DesktopComputerAppSetupStep => ({
        grant,
        kind,
        state,
      })),
      targetName: targetApps[setup.definitionId].name,
      thisAppHasFullDiskAccess,
    };
  }

  #fail(stage: string, definitionId: ComputerUseDataAppId, error: unknown): void {
    this.#options.log?.("desktop.computer-app.setup-step-failed", {
      definitionId,
      message: error instanceof Error ? error.message : "setup step failed",
      stage,
    });
  }
}

function wider(access: IntegrationAccess, than: IntegrationAccess): boolean {
  return access === "read-write" && than === "read";
}

/**
 * The grants this access needs that macOS does not give yet, reads first.
 * Full Disk Access, and any grant macOS refused before, is a switch in System
 * Settings; the rest are questions macOS asks in place.
 */
export function missingSteps(
  definitionId: ComputerUseDataAppId,
  access: IntegrationAccess,
  grants: ComputerUseDataGrants,
): readonly { readonly grant: ComputerUseDataGrant; readonly kind: Step["kind"] }[] {
  const app = computerUseDataApps[definitionId];
  return [...new Set(access === "read-write" ? [app.read, app.write] : [app.read])]
    .filter((grant) => grants[grant] !== "granted")
    .map((grant) => ({
      grant,
      kind: grant === "full-disk-access" || grants[grant] === "denied" ? "settings" : "ask",
    }));
}
