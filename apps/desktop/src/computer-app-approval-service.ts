import type { DeploymentId } from "@opensteer/core";
import {
  ComputerAppSetupRequestSchema,
  computerAppIdentitiesEqual,
  isComputerAppDefinition,
  parseComputerAppConfig,
  type ComputerAppApproval,
  type ComputerAppSetupRequest,
  type IntegrationAccess,
  type IntegrationDefinition,
} from "@opensteer/integration-core";
import {
  ComputerUseDataAppIdSchema,
  type ComputerAppApprovalAnswerFrame,
  type ComputerAppApprovalKeyChallenge,
  type ComputerAppApprovalKeyProof,
  type ComputerAppApprovalList,
  type ComputerAppApprovalOutcomeFrame,
  type ComputerAppApprovalPrompt,
  type ComputerUseDataAppId,
  type ComputerUseResolvedApp,
} from "@opensteer/protocol";
import type {
  DesktopComputerUseApprovalApp,
  DesktopComputerUseApprovalPresentation,
  DesktopReviewComputerAppSetupResult,
} from "@opensteer/protocol/desktop";
import { computerUseAccessLabel, computerUseAccessSummary } from "@opensteer/client/integrations";
import { localMcpLaunchDigest } from "@opensteer/integration-core/digest";
import type { ComputerUseRunnerTargetResult } from "./supervisor/local-runner-authority.js";

/** An MCP server and the exact launch the person allowed on this Mac. */
export interface AllowedServer {
  readonly launchDigest: string;
  readonly serverId: string;
}

interface LocalApprover {
  assertComputerAppSetupTarget(request: ComputerAppSetupRequest): Promise<void>;
  checkComputerUseRunnerTarget(
    deploymentId: string,
    runnerId: string,
  ): Promise<ComputerUseRunnerTargetResult>;
}

/** The panel's presentation before the panel mints the token that names it. */
export type ComputerAppApprovalPresentation = WithoutToken<DesktopComputerUseApprovalPresentation>;
type WithoutToken<Presentation> = Presentation extends unknown
  ? Omit<Presentation, "token">
  : never;

/** How long a page waits for the approval it just created to reach this Mac. */
const defaultArrivalTimeoutMs = 30_000;

export const computerAppApprovalKeyMissingSentence =
  "This Mac cannot approve apps yet. Open this Mac's page in Opensteer to finish setting up computer use, then try again.";
const undeliveredSentence =
  "This Mac lost its connection to Opensteer before your answer was sent. Try again.";
const quittingSentence = "Opensteer is quitting, so this approval was not shown.";

interface ComputerAppApprovalServiceOptions {
  readonly approvalKey: {
    publicKey(): Promise<{ readonly keyId: string }>;
    sign(
      request: ComputerAppSetupRequest,
      decision: "allow" | "deny",
    ): Promise<ComputerAppApproval>;
    prove(challenge: ComputerAppApprovalKeyChallenge): Promise<ComputerAppApprovalKeyProof>;
  };
  /**
   * The app's 64×64 icon, which `app.resolve` does not carry — only the picker
   * listing does. It is separate and optional so a missing icon is a panel
   * without a picture rather than an approval nobody can give.
   */
  readonly appIcon?: (bundleId: string) => Promise<string | null>;
  /** How long `review` waits for a request to arrive; shortened by tests. */
  readonly arrivalTimeoutMs?: number;
  readonly catalog: {
    load(): Promise<{
      readonly deployments: readonly {
        readonly name: string;
        readonly authority: { readonly document: { readonly deploymentId: string } };
      }[];
    }>;
  };
  /**
   * Shows the panel and resolves with the person's answer. Aborting the signal
   * closes it unanswered: the approval ended somewhere else.
   */
  readonly confirm: (
    input: ComputerAppApprovalPresentation,
    signal: AbortSignal,
  ) => Promise<boolean>;
  /**
   * Sets up an app the helper serves on this Mac once the Host accepts the
   * person's Allow: the setup guide takes whatever macOS steps that access
   * still needs, or nothing. Absent where no helper holds grants.
   */
  readonly setUp?: (input: {
    readonly access: IntegrationAccess;
    readonly definitionId: ComputerUseDataAppId;
  }) => void;
  readonly definitions: readonly IntegrationDefinition[];
  readonly local: LocalApprover;
  readonly log?: (event: string, fields?: Readonly<Record<string, string>>) => void;
  /** The OS name of this Mac, which the panel shows as the target. */
  readonly machineName: () => Promise<string>;
  readonly personal: LocalApprover & { readonly status: { readonly deploymentId: string | null } };
  /**
   * The Mac's own answer about one app, from the helper. Absent on a platform
   * with no helper, which is also every platform with no `macos-app`.
   */
  readonly resolveApp?: (app: string) => Promise<ComputerUseResolvedApp>;
  /**
   * Sends the person's answer on that slot's Runner, which carries it to its
   * Host. False when that Runner is not connected to this desktop right now.
   */
  readonly sendAnswer: (
    deploymentId: DeploymentId,
    frame: ComputerAppApprovalAnswerFrame,
    server: AllowedServer | null,
  ) => boolean;
}

type OfferState =
  /** Waiting its turn. */
  | "queued"
  /** Its panel is open. */
  | "showing"
  /** Answered here; the Host's outcome has not arrived. */
  | "answered"
  /** Not shown: the Host accepts another key from this Mac, or none. */
  | "held"
  /** Not shown again while listed: the Host refused the answer, or this Mac cannot ask it. */
  | "refused";

interface Waiter {
  readonly reject: (error: Error) => void;
  readonly resolve: (result: DesktopReviewComputerAppSetupResult) => void;
}

interface Offer {
  abort: AbortController | null;
  readonly deploymentId: DeploymentId;
  prompt: ComputerAppApprovalPrompt;
  /** The app the helper serves that this person allowed, to set up once accepted. */
  setUpAfter: {
    readonly access: IntegrationAccess;
    readonly definitionId: ComputerUseDataAppId;
  } | null;
  state: OfferState;
  readonly waiters: Waiter[];
}

/** Why a request was not shown; `lasting` ones are not asked again while listed. */
class NotAsked extends Error {
  readonly lasting: boolean;

  constructor(message: string, lasting: boolean, options?: ErrorOptions) {
    super(message, options);
    this.lasting = lasting;
    this.name = "NotAsked";
  }
}

/**
 * This Mac's approval panels, fed by the Runners it supervises.
 *
 * Each Runner slot relays its Host's complete list of approvals waiting on
 * this Mac, and this service shows them one panel at a time, in the order they
 * arrived, whichever Deployment each came from. The list is the only source:
 * nothing here reads a Host with the person's session, so an approval reaches
 * this Mac however the person signed in, and the moment its Runner is back.
 * An approval missing from its slot's next list has ended elsewhere, and its
 * panel closes and the next one shows. The person's answer — a signature by
 * this desktop's approval key, or a refusal — goes back on the same slot's
 * Runner, and the Host's outcome settles whatever page was waiting on it.
 */
export class ComputerAppApprovalService {
  readonly #options: ComputerAppApprovalServiceOptions;
  readonly #offers = new Map<string, Offer>();
  /** Arrival order, which is the order panels are shown in. */
  #order: string[] = [];
  /** The approval key id each slot's Host last said it accepts. */
  readonly #acceptedKeys = new Map<DeploymentId, string | null>();
  /** Pages waiting for a request that has not reached this Mac yet. */
  readonly #arrivals = new Map<
    string,
    { readonly timer: NodeJS.Timeout; readonly waiters: Waiter[] }
  >();
  #showing: Offer | null = null;
  #closed = false;

  constructor(options: ComputerAppApprovalServiceOptions) {
    this.#options = options;
  }

  /** Approval and explicit activation use the same enrolled local-machine authority. */
  checkComputerUseRunnerTarget(
    deploymentId: string,
    runnerId: string,
  ): Promise<ComputerUseRunnerTargetResult> {
    const approver =
      this.#options.personal.status.deploymentId === deploymentId
        ? this.#options.personal
        : this.#options.local;
    return approver.checkComputerUseRunnerTarget(deploymentId, runnerId);
  }

  /** The live slot's desktop proves it holds the key the owner nominated. */
  async proveKeyChallenge(
    deploymentId: DeploymentId,
    challenge: ComputerAppApprovalKeyChallenge,
  ): Promise<ComputerAppApprovalKeyProof> {
    const target = await this.checkComputerUseRunnerTarget(deploymentId, challenge.runnerId);
    if (!target.local)
      throw new Error("Computer app approval does not target this Mac's current enrolled Runner");
    return this.#options.approvalKey.prove(challenge);
  }

  /** One slot's Host's complete list of approvals waiting on this Mac. */
  list(deploymentId: DeploymentId, list: ComputerAppApprovalList): void {
    if (this.#closed) return;
    const previousKeyId = this.#acceptedKeys.get(deploymentId);
    this.#acceptedKeys.set(deploymentId, list.approvalKeyId);
    const listed = new Map<string, ComputerAppApprovalPrompt>();
    for (const prompt of list.approvals) {
      // A Host lists only its own requests; one naming another Deployment
      // would be signed for that Deployment's Runner and answered on this one.
      if (prompt.request.deploymentId !== deploymentId) {
        this.#log("desktop.computer-app.approval-foreign", {
          deploymentId,
          requestId: prompt.request.id,
        });
        continue;
      }
      listed.set(offerKey(deploymentId, prompt.request.id), prompt);
    }
    for (const [key, offer] of Array.from(this.#offers)) {
      if (offer.deploymentId !== deploymentId || listed.has(key)) continue;
      this.#end(key, offer, { allowed: false });
    }
    for (const [key, prompt] of listed) {
      const offer = this.#offers.get(key);
      if (offer) {
        offer.prompt = prompt;
        continue;
      }
      const arrival = this.#arrivals.get(key);
      if (arrival) {
        clearTimeout(arrival.timer);
        this.#arrivals.delete(key);
      }
      this.#offers.set(key, {
        abort: null,
        deploymentId,
        prompt,
        setUpAfter: null,
        state: "queued",
        waiters: arrival ? [...arrival.waiters] : [],
      });
      this.#order.push(key);
    }
    // A key registered since these were held is the Host now accepting
    // answers from this Mac, so they are asked.
    for (const offer of this.#offers.values()) {
      if (
        offer.deploymentId === deploymentId &&
        offer.state === "held" &&
        previousKeyId !== list.approvalKeyId
      )
        offer.state = "queued";
    }
    this.#pump();
  }

  /** A slot left: the next authoritative list starts its panels fresh. */
  disconnected(deploymentId: DeploymentId): void {
    this.#acceptedKeys.delete(deploymentId);
    for (const [key, offer] of Array.from(this.#offers)) {
      if (offer.deploymentId !== deploymentId) continue;
      this.#offers.delete(key);
      this.#order = this.#order.filter((entry) => entry !== key);
      offer.abort?.abort();
      if (this.#showing === offer) this.#showing = null;
      settle(offer.waiters, new Error(undeliveredSentence));
    }
    for (const [key, arrival] of Array.from(this.#arrivals)) {
      if (!key.startsWith(`${deploymentId} `)) continue;
      clearTimeout(arrival.timer);
      this.#arrivals.delete(key);
      settle(arrival.waiters, new Error(undeliveredSentence));
    }
    this.#pump();
  }

  /** What the Host did with this Mac's answer to one request. */
  outcome(deploymentId: DeploymentId, frame: ComputerAppApprovalOutcomeFrame): void {
    const key = offerKey(deploymentId, frame.setupRequestId);
    const offer = this.#offers.get(key);
    if (!offer) return;
    if (frame.outcome.kind === "refused") {
      // Nothing changed on the Host, so the request is still listed; showing
      // it again unasked would put the same refused question up forever.
      this.#log("desktop.computer-app.answer-refused", {
        deploymentId,
        message: frame.outcome.message,
        requestId: frame.setupRequestId,
      });
      offer.state = "refused";
      offer.setUpAfter = null;
      settle(offer.waiters, new Error(frame.outcome.message));
      return;
    }
    const setUp =
      frame.outcome.kind === "allowed" && offer.state === "answered" ? offer.setUpAfter : null;
    this.#end(key, offer, { allowed: frame.outcome.kind === "allowed" });
    if (setUp) this.#options.setUp?.(setUp);
  }

  /**
   * Waits for this Mac's answer to a request a page on this Mac just created.
   *
   * The page does not show anything itself: the Host pushes the request to
   * this Mac's Runner as it does every other, and the panel comes from that.
   * A request the page asks about is shown next, and one this Mac stopped
   * asking about is asked again, because the person just asked for it.
   */
  review(
    deploymentId: DeploymentId,
    setupRequestId: string,
  ): Promise<DesktopReviewComputerAppSetupResult> {
    if (this.#closed) return Promise.reject(new Error(quittingSentence));
    const key = offerKey(deploymentId, setupRequestId);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { reject, resolve };
      const offer = this.#offers.get(key);
      if (!offer) {
        const arrival = this.#arrivals.get(key);
        if (arrival) {
          arrival.waiters.push(waiter);
          return;
        }
        const timer = setTimeout(() => {
          const waiting = this.#arrivals.get(key);
          this.#arrivals.delete(key);
          settle(
            waiting?.waiters ?? [],
            new Error(
              "The approval did not reach this Mac. Check that Opensteer on this Mac is connected, then try again.",
            ),
          );
        }, this.#options.arrivalTimeoutMs ?? defaultArrivalTimeoutMs);
        timer.unref();
        this.#arrivals.set(key, { timer, waiters: [waiter] });
        return;
      }
      offer.waiters.push(waiter);
      if (offer.state === "refused") offer.state = "queued";
      this.#pump();
    });
  }

  /**
   * Quitting: the open panel closes unanswered and nothing more is shown. No
   * approval is declined for it — a question nobody answered is still a
   * question, and the next launch asks it.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#showing?.abort?.abort();
    for (const offer of this.#offers.values()) settle(offer.waiters, new Error(quittingSentence));
    for (const { timer, waiters } of this.#arrivals.values()) {
      clearTimeout(timer);
      settle(waiters, new Error(quittingSentence));
    }
    this.#arrivals.clear();
    this.#offers.clear();
    this.#order = [];
  }

  /** An approval that ended: its panel closes, its page learns, the next one shows. */
  #end(key: string, offer: Offer, result: DesktopReviewComputerAppSetupResult): void {
    if (this.#offers.get(key) !== offer) return;
    this.#offers.delete(key);
    this.#order = this.#order.filter((entry) => entry !== key);
    offer.abort?.abort();
    if (this.#showing === offer) this.#showing = null;
    settle(offer.waiters, result);
    this.#pump();
  }

  #pump(): void {
    if (this.#closed || this.#showing) return;
    const queued = this.#order
      .map((key) => this.#offers.get(key))
      .filter((offer): offer is Offer => offer?.state === "queued");
    // A request a page on this Mac is waiting for goes first: the person is
    // looking at that page, having just asked for it.
    const next = queued.find((offer) => offer.waiters.length > 0) ?? queued[0];
    if (!next) return;
    const abort = new AbortController();
    next.abort = abort;
    next.state = "showing";
    this.#showing = next;
    void this.#ask(next, abort.signal).finally(() => {
      if (this.#showing === next) this.#showing = null;
      next.abort = null;
      this.#pump();
    });
  }

  async #ask(offer: Offer, signal: AbortSignal): Promise<void> {
    const request = offer.prompt.request;
    const key = offerKey(offer.deploymentId, request.id);
    try {
      const { keyId } = await this.#options.approvalKey.publicKey();
      if (signal.aborted || this.#offers.get(key) !== offer) return;
      if (this.#acceptedKeys.get(offer.deploymentId) !== keyId) {
        this.#log("desktop.computer-app.approval-key-unregistered", {
          deploymentId: offer.deploymentId,
          requestId: request.id,
        });
        offer.state = "held";
        settle(offer.waiters, new Error(computerAppApprovalKeyMissingSentence));
        return;
      }
      const { allowed, setUpAfter } = await this.#confirm(request, signal);
      if (signal.aborted || this.#offers.get(key) !== offer) return;
      const decision = allowed ? "allow" : "deny";
      const answer: ComputerAppApprovalAnswerFrame = {
        answer: {
          approval: await this.#options.approvalKey.sign(request, decision),
          kind: decision,
        },
        setupRequestId: request.id,
      };
      if (signal.aborted || this.#offers.get(key) !== offer) return;
      // The launch this person saw and allowed, which is what the Runner
      // will run, from the request signed here rather than any later list.
      const server =
        allowed && request.kind === "server" && request.server
          ? {
              launchDigest: localMcpLaunchDigest(request.server.launch),
              serverId: request.server.serverId,
            }
          : null;
      if (!this.#options.sendAnswer(offer.deploymentId, answer, server)) {
        // Nothing reached the Host, so the request is still waiting there; the
        // Runner's next list brings it back to be asked again.
        this.#log("desktop.computer-app.answer-undelivered", {
          deploymentId: offer.deploymentId,
          requestId: request.id,
        });
        settle(offer.waiters, new Error(undeliveredSentence));
        this.#end(key, offer, { allowed: false });
        return;
      }
      offer.setUpAfter = allowed ? setUpAfter : null;
      offer.state = "answered";
    } catch (error) {
      if (signal.aborted || this.#closed || this.#offers.get(key) !== offer) return;
      this.#log("desktop.computer-app.approval-not-asked", {
        deploymentId: offer.deploymentId,
        message: error instanceof Error ? error.message : "not asked",
        requestId: request.id,
      });
      const failure = error instanceof Error ? error : new Error("This approval was not shown.");
      if (error instanceof NotAsked && error.lasting) {
        offer.state = "refused";
        settle(offer.waiters, failure);
        return;
      }
      // Not asked for a reason that may pass — the helper was unreachable, the
      // panel could not load — so the next list asks it again.
      settle(offer.waiters, failure);
      this.#end(key, offer, { allowed: false });
    }
  }

  /**
   * Shows one request and returns the person's answer with the helper app to
   * set up once it is accepted, if any. An app this Mac will never operate is
   * refused here without asking the person.
   */
  async #confirm(
    pendingRequest: ComputerAppSetupRequest,
    signal: AbortSignal,
  ): Promise<{ readonly allowed: boolean; readonly setUpAfter: Offer["setUpAfter"] }> {
    const request = ComputerAppSetupRequestSchema.parse(pendingRequest);
    const approver =
      this.#options.personal.status.deploymentId === request.deploymentId
        ? this.#options.personal
        : this.#options.local;
    // Prove this main process supervises the exact target before showing
    // anything; everything below it is presentation.
    try {
      await approver.assertComputerAppSetupTarget(request);
    } catch (error) {
      throw new NotAsked("This approval is for another computer.", true, { cause: error });
    }
    if (signal.aborted) throw new NotAsked("This approval ended before it was shown.", false);
    const deployment = (await this.#options.catalog.load()).deployments.find(
      ({ authority }) => authority.document.deploymentId === request.deploymentId,
    );
    if (!deployment) throw new NotAsked("This approval names an unknown Deployment.", false);
    const machineName = await this.#options.machineName();
    if (signal.aborted) throw new NotAsked("This approval ended before it was shown.", false);
    if (request.kind === "policy") {
      return {
        allowed: await this.#options.confirm(
          {
            appApproval: "automatic",
            deploymentName: deployment.name,
            kind: "policy",
            machineName,
          },
          signal,
        ),
        setUpAfter: null,
      };
    }
    // What will run here is what the request names, verbatim: the Host
    // signed nothing else, and this Mac runs nothing else.
    if (request.kind === "server" && request.server) {
      return {
        allowed: await this.#options.confirm(
          {
            deploymentName: deployment.name,
            installationTitle: request.server.installationTitle,
            kind: "server",
            launch: request.server.launch,
            machineName,
            serverName: request.server.name,
          },
          signal,
        ),
        setUpAfter: null,
      };
    }
    const definition = this.#options.definitions.find(({ id }) => id === request.definitionId);
    if (!definition || !isComputerAppDefinition(definition)) {
      throw new NotAsked("This approval names an app this Opensteer does not know.", true);
    }
    const config = parseComputerAppConfig(definition);
    // Computer use has one vocabulary for its two levels and every client
    // surface reads it from the same place, so a GUI app's panel says exactly
    // what the Mac's page and the phone say. Every other computer app is its
    // own definition's words, which is where its two levels are described.
    const gui = config.kind === "gui";
    const accessLabel = gui
      ? computerUseAccessLabel[request.access]
      : request.access === "read-write"
        ? config.accessLabels.readWrite
        : config.accessLabels.read;
    const accessSummary = gui
      ? computerUseAccessSummary[request.access]
      : request.access === "read-write"
        ? config.accessSummaries.readWrite
        : config.accessSummaries.read;
    const app = await this.#presentApp(definition, request);
    if (signal.aborted) throw new NotAsked("This approval ended before it was shown.", false);
    // A refused app never reaches the panel: asking a person to approve
    // something this Mac will not do is a question with no true answer.
    if (app === null) return { allowed: false, setUpAfter: null };
    const helperApp = ComputerUseDataAppIdSchema.safeParse(definition.id);
    const setUpAfter =
      request.kind === "app" && request.app === null && helperApp.success
        ? { access: request.access, definitionId: helperApp.data }
        : null;
    const allowed = await this.#options.confirm(
      {
        access: request.access,
        accessLabel,
        accessSummary,
        app,
        deploymentName: deployment.name,
        kind: "app",
        machineName,
        // A Thread can be untitled and a model can give an empty reason; the
        // panel omits a line rather than print an empty one.
        reason: request.reason || null,
        threadTitle: request.threadTitle || null,
        workspaceName: request.workspaceName,
      },
      signal,
    );
    return { allowed, setUpAfter };
  }

  /**
   * What the panel says about the app, or null when this Mac refuses it.
   *
   * For `macos-app` the identity is resolved through the helper, so the panel
   * shows the app the Mac found — its icon, its real path, the elevated note —
   * rather than a name the Host carried. For every other computer app the
   * connection is the definition on the Runner and nothing finer, so the
   * definition's own name is the truthful thing to show and there is no icon.
   *
   * Null is a **refusal** — no helper on this platform, or an app the helper's
   * deny list names — and the caller declines the request on the strength of
   * it. A helper that could not be reached is a different thing and throws, so
   * a Mac whose helper is momentarily down does not decline a question nobody
   * was asked. So does an app that is no longer the one the request names:
   * nobody declined it, and the Thread must not be told they did.
   */
  async #presentApp(
    definition: IntegrationDefinition,
    request: ComputerAppSetupRequest,
  ): Promise<DesktopComputerUseApprovalApp | null> {
    if (request.app === null) {
      return {
        bundleId: definition.id,
        displayName: definition.name,
        iconPng: null,
        path: null,
        reason: null,
        risk: "standard",
      };
    }
    const resolve = this.#options.resolveApp;
    if (!resolve) {
      this.#log("desktop.computer-app.resolve-unavailable", { bundleId: request.app.bundleId });
      return null;
    }
    let resolved: ComputerUseResolvedApp;
    try {
      resolved = await resolve(request.app.bundleId);
    } catch (error) {
      throw new NotAsked("This Mac could not resolve the app this request names.", false, {
        cause: error,
      });
    }
    if (!resolved.allowed) {
      this.#log("desktop.computer-app.not-allowed", {
        bundleId: request.app.bundleId,
        reason: resolved.reason ?? "refused by this Mac",
      });
      return null;
    }
    if (!computerAppIdentitiesEqual(resolved.identity, request.app)) {
      throw new NotAsked(
        `${resolved.identity.displayName} on this Mac is no longer the app this request names, so it was not shown.`,
        true,
      );
    }
    const iconPng =
      (await this.#options.appIcon?.(resolved.identity.bundleId).catch(() => null)) ?? null;
    return {
      bundleId: resolved.identity.bundleId,
      displayName: resolved.identity.displayName,
      iconPng,
      path: resolved.path,
      reason: resolved.reason,
      risk: resolved.risk,
    };
  }

  #log(event: string, fields: Readonly<Record<string, string>>): void {
    this.#options.log?.(event, fields);
  }
}

function offerKey(deploymentId: DeploymentId, setupRequestId: string): string {
  return `${deploymentId} ${setupRequestId}`;
}

/** Answers every waiter once and forgets them. */
function settle(waiters: Waiter[], outcome: DesktopReviewComputerAppSetupResult | Error): void {
  for (const waiter of waiters.splice(0)) {
    if (outcome instanceof Error) waiter.reject(outcome);
    else waiter.resolve(outcome);
  }
}
