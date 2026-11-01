import {
  AgentPhoneEnrollments,
  agentPhoneSetupHost,
  setupAgentPhone,
  type AgentPhoneArtifact,
  type AgentPhoneFacts,
  type AgentPhoneSetupIssue,
  type AgentPhoneSetupStep,
} from "@opensteer/agent-phone-setup";
import {
  agentPhoneUsb,
  chooseAgentPhone,
  grantedAgentPhones,
  type AgentPhoneUsbDevice,
} from "@opensteer/agent-phone-setup/webusb";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import type { DesktopUsbDeviceChoice, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { connectPhoneForSetup } from "../../computers/agent-phone-connection.js";
import { loadAgentPhoneArtifact } from "../../computers/agent-phone-setup.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { Icon, type IconName } from "../icon.js";

/**
 * Setting an Android phone up over USB, once.
 *
 * The phone is plugged into the computer this page is open on; everything
 * after the person picks it and allows USB debugging happens without them,
 * unless setup must erase or unpair something first. The dialog shows only
 * the setup engine's current step, named the way the person experiences it.
 */

type WizardStep = "connect" | "authorize" | "check" | "install" | "configure" | "pair";

/** Why the last attempt to reach the phone ended. */
type ConnectNote = "busy" | "not-chosen" | "unauthorized";

/** What setup asks the person before it removes or unpairs anything on the phone. */
type Question =
  { readonly kind: "uninstall" } | { readonly hostUrl: string; readonly kind: "unpair" };

type Phase =
  | { readonly kind: "loading" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "no-artifact" }
  | { readonly kind: "ready"; readonly note: ConnectNote | null }
  | { readonly choice: DesktopUsbDeviceChoice | null; readonly kind: "choosing" }
  | {
      readonly kind: "running";
      /** Asked of the person while the step waits on their answer. */
      readonly question: Question | null;
      readonly step: WizardStep;
    }
  | { readonly kind: "disconnected" }
  | {
      readonly issue: AgentPhoneSetupIssue;
      readonly kind: "issue";
      readonly runnerId: string | null;
    }
  | { readonly kind: "done"; readonly runnerId: string }
  | { readonly kind: "failed"; readonly message: string };

interface SetupAttempt {
  readonly abort: AbortController;
  cancelChoice: (() => void) | null;
  close: () => void;
}

export function AddPhoneDialog({
  client,
  deploymentKind,
  deploymentName,
  desktopBridge,
  homeName,
  onClose,
  phoneName,
}: {
  readonly client: HostClient;
  readonly deploymentKind: "personal" | "server" | null;
  readonly deploymentName: string;
  readonly desktopBridge: OpensteerDesktopBridge | null;
  /** The Mac a Personal Opensteer runs on, which the phone must be able to reach. */
  readonly homeName: string;
  readonly onClose: () => void;
  /** Set when an existing phone is plugged in again, to update it or finish its setup. */
  readonly phoneName?: string;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [phone, setPhone] = useState<AgentPhoneFacts | null>(null);
  const [artifact, setArtifact] = useState<AgentPhoneArtifact | null>(null);
  // Every run of setup in this dialog continues one sequence of enrollments:
  // a phone unplugged and plugged back in, or "Try again", is handed the
  // enrollment it may already hold, and a new one only once that one is spent.
  const [enrollments] = useState(
    () => new AgentPhoneEnrollments(mutationIdempotencyKey("agent-phone-enrollment")),
  );
  const device = useRef<AgentPhoneUsbDevice | null>(null);
  const attempt = useRef<SetupAttempt | null>(null);
  const answer = useRef<((confirmed: boolean) => void) | null>(null);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const connectAndRunRef = useRef(connectAndRun);
  connectAndRunRef.current = connectAndRun;

  useEffect(() => {
    const abort = new AbortController();
    if (!agentPhoneUsb()) {
      setPhase({ kind: "unsupported" });
      return () => abort.abort();
    }
    void loadAgentPhoneArtifact({ bridge: desktopBridge, signal: abort.signal }).then(
      (loaded) => {
        if (abort.signal.aborted) return;
        setArtifact(loaded);
        setPhase(loaded ? { kind: "ready", note: null } : { kind: "no-artifact" });
      },
      (reason: unknown) => {
        if (!abort.signal.aborted)
          setPhase({ kind: "failed", message: actionErrorMessage(reason) });
      },
    );
    return () => abort.abort();
  }, [desktopBridge]);

  // The desktop has no chooser of its own; when several phones are plugged in
  // it asks this page, which shows them in the dialog.
  useEffect(() => {
    if (!desktopBridge) return;
    return desktopBridge.onUsbDeviceChoice((choice) => {
      const decline = () =>
        void desktopBridge
          .chooseUsbDevice({ choiceId: choice.choiceId, deviceId: null })
          .catch(() => undefined);
      const session = attempt.current;
      if (!session) {
        decline();
        return;
      }
      session.cancelChoice = decline;
      setPhase({ choice, kind: "choosing" });
    });
  }, [desktopBridge]);

  // Unplugging the phone stops setup where it is; plugging the same phone back
  // in picks it up again, and setup continues from whatever the phone has.
  useEffect(() => {
    const usb = agentPhoneUsb();
    if (!usb || !artifact) return;
    const disconnected = (event: USBConnectionEvent) => {
      if (event.device !== device.current?.raw || phaseRef.current.kind !== "running") return;
      cancelAttempt(new Error("The phone was unplugged."));
      setPhase({ kind: "disconnected" });
    };
    const connected = (event: USBConnectionEvent) => {
      if (phaseRef.current.kind !== "disconnected") return;
      const serial = device.current?.serial;
      const session = beginAttempt();
      void grantedAgentPhones(usb).then(
        (devices) => {
          if (!isCurrent(session)) return;
          const again = devices.find(
            (candidate) => candidate.raw === event.device && candidate.serial === serial,
          );
          if (again && phaseRef.current.kind === "disconnected") {
            void connectAndRunRef.current(again, artifact, session);
          }
        },
        (reason: unknown) => {
          if (isCurrent(session)) setPhase({ kind: "failed", message: actionErrorMessage(reason) });
        },
      );
    };
    usb.addEventListener("disconnect", disconnected);
    usb.addEventListener("connect", connected);
    return () => {
      usb.removeEventListener("disconnect", disconnected);
      usb.removeEventListener("connect", connected);
    };
  }, [artifact]);

  useEffect(() => () => cancelAttempt(new Error("Setup was closed.")), []);

  /** Only the newest attempt may change the dialog; cancelling one also replaces it. */
  function isCurrent(session: SetupAttempt): boolean {
    return attempt.current === session;
  }

  function cancelAttempt(reason: Error) {
    const session = attempt.current;
    attempt.current = null;
    answer.current?.(false);
    session?.abort.abort(reason);
    session?.close();
    session?.cancelChoice?.();
  }

  function beginAttempt(): SetupAttempt {
    cancelAttempt(new Error("Setup was restarted."));
    const session: SetupAttempt = {
      abort: new AbortController(),
      cancelChoice: null,
      close: () => undefined,
    };
    attempt.current = session;
    return session;
  }

  function closeSetup() {
    cancelAttempt(new Error("Setup was closed."));
    onClose();
  }

  function ask(question: Question, session: SetupAttempt): Promise<boolean> {
    if (!isCurrent(session)) return Promise.resolve(false);
    return new Promise((resolve) => {
      answer.current = (confirmed) => {
        answer.current = null;
        resolve(confirmed);
      };
      setPhase((current) => (current.kind === "running" ? { ...current, question } : current));
    });
  }

  function answered(confirmed: boolean) {
    answer.current?.(confirmed);
    setPhase((current) => (current.kind === "running" ? { ...current, question: null } : current));
  }

  async function choose() {
    const usb = agentPhoneUsb();
    if (!usb || !artifact) return;
    const session = beginAttempt();
    setPhase({ choice: null, kind: "choosing" });
    let chosen: AgentPhoneUsbDevice | null;
    try {
      chosen = await chooseAgentPhone(usb);
    } catch (reason) {
      if (isCurrent(session)) setPhase({ kind: "failed", message: actionErrorMessage(reason) });
      return;
    }
    if (!isCurrent(session)) return;
    session.cancelChoice = null;
    if (!chosen) {
      setPhase({ kind: "ready", note: "not-chosen" });
      return;
    }
    await connectAndRun(chosen, artifact, session);
  }

  async function connectAndRun(
    chosen: AgentPhoneUsbDevice,
    loaded: AgentPhoneArtifact,
    session: SetupAttempt = beginAttempt(),
  ) {
    if (!isCurrent(session)) return;
    const { abort } = session;
    device.current = chosen;
    setPhase({ kind: "running", question: null, step: "connect" });
    try {
      const connection = await connectPhoneForSetup(chosen, {
        native: desktopBridge?.agentPhoneAdb,
        onAuthorizePrompt: () => {
          if (isCurrent(session)) {
            setPhase({ kind: "running", question: null, step: "authorize" });
          }
        },
        signal: abort.signal,
      });
      if (!isCurrent(session)) {
        if (connection.kind === "connected") await connection.close().catch(() => undefined);
        return;
      }
      if (connection.kind !== "connected") {
        setPhase({ kind: "ready", note: connection.kind });
        return;
      }
      session.close = () => {
        session.close = () => undefined;
        void connection.close().catch(() => undefined);
      };
      const result = await setupAgentPhone({
        adb: connection.adb,
        artifact: loaded,
        confirmUninstall: () => ask({ kind: "uninstall" }, session),
        confirmUnpair: ({ hostUrl }) => ask({ hostUrl, kind: "unpair" }, session),
        enrollments,
        host: agentPhoneSetupHost(client),
        onStep: (step) => {
          if (!isCurrent(session)) return;
          if (step.step === "inspect" && step.phone) setPhone(step.phone);
          if (step.step === "done") return;
          setPhase({
            kind: "running",
            question: null,
            step: wizardStep(step),
          });
        },
        runnerName: phoneName ?? (chosen.name?.trim() || "Android phone"),
        signal: abort.signal,
      });
      session.close();
      if (!isCurrent(session)) return;
      // The page's list also follows the Host's own change events; a refresh
      // that fails here changes nothing about how setup ended.
      await client.refresh().catch(() => undefined);
      if (!isCurrent(session)) return;
      setPhase(
        result.outcome === "done"
          ? { kind: "done", runnerId: result.runnerId }
          : { issue: result.issue, kind: "issue", runnerId: result.runnerId },
      );
    } catch (reason) {
      session.close();
      // An unplugged phone or a closed dialog already said what happened.
      if (!isCurrent(session)) return;
      setPhase({ kind: "failed", message: actionErrorMessage(reason) });
    }
  }

  function retry() {
    if (device.current && artifact) void connectAndRun(device.current, artifact);
    else setPhase({ kind: "ready", note: null });
  }

  function answerChoice(choice: DesktopUsbDeviceChoice, deviceId: string | null) {
    const session = attempt.current;
    if (!desktopBridge || !session) return;
    void desktopBridge
      .chooseUsbDevice({ choiceId: choice.choiceId, deviceId })
      .catch((reason: unknown) => {
        if (isCurrent(session)) setPhase({ kind: "failed", message: actionErrorMessage(reason) });
      });
    setPhase({ choice: null, kind: "choosing" });
  }

  /** What the dialog shows for the phase it is in. */
  function stage(): StageProps {
    const desktop = desktopBridge !== null;
    switch (phase.kind) {
      case "unsupported":
        return {
          detail:
            "Open Opensteer in Chrome or the desktop app on the computer the phone plugs into.",
          title: "This browser can’t reach a phone over USB",
          tone: "problem",
        };
      case "no-artifact":
        return {
          detail: "It doesn’t include the Agent Phone app.",
          title: "This Opensteer build can’t set up phones",
          tone: "problem",
        };
      case "loading":
        return { title: "Getting Agent Phone ready", tone: "working" };
      case "ready":
        return readyStage({
          deploymentKind,
          desktop,
          homeName,
          note: phase.note,
          onConnect: () => void choose(),
          phoneName: phoneName ?? null,
        });
      case "choosing": {
        const { choice } = phase;
        if (choice) return choiceStage(choice, (deviceId) => answerChoice(choice, deviceId));
        // The desktop picks a lone phone itself, and asks only when there are several.
        return desktop
          ? { title: "Looking for the phone", tone: "working" }
          : { cue: "Your turn", title: "Choose the phone in the list that opened", tone: "you" };
      }
      case "running":
        return phase.question
          ? confirmStage(phase.question, phase.step, deploymentName, answered)
          : runningStage(phase.step, phone, deploymentName);
      case "disconnected":
        return {
          cue: "Your turn",
          detail: "Setup continues where it stopped.",
          title: "Plug the phone back in",
          tone: "you",
        };
      case "done":
        return {
          actions: (
            <Link
              className="btn btn--primary"
              onClick={closeSetup}
              to={`/settings/computers/${encodeURIComponent(phase.runnerId)}`}
            >
              Open the phone’s page
            </Link>
          ),
          detail: phone?.secureLock
            ? `Agents in ${deploymentName} can use it while it’s online. They unlock it with the PIN you give them; after a restart, unlock it once yourself.`
            : `Agents in ${deploymentName} can use it while it’s online.`,
          title: phone ? `${phone.model} is ready` : "The phone is ready",
          tone: "done",
        };
      case "issue":
      case "failed": {
        const remoteAccessOff = phase.kind === "issue" && phase.issue.code === "remote-access-off";
        return {
          actions: (
            <>
              {remoteAccessOff ? (
                <Link className="btn btn--primary" onClick={closeSetup} to="/settings/devices">
                  Open Remote access
                </Link>
              ) : null}
              <button
                className={remoteAccessOff ? "btn" : "btn btn--primary"}
                onClick={retry}
                type="button"
              >
                Try again
              </button>
            </>
          ),
          detail:
            phase.kind === "issue"
              ? issueText(phase.issue, { deploymentName, homeName })
              : phase.message,
          title: "Setup stopped",
          tone: "problem",
        };
      }
    }
  }

  const busy = phase.kind === "running" || phase.kind === "choosing";
  return (
    <Dialog
      footer={
        <button className="btn" onClick={closeSetup} type="button">
          {phase.kind === "done" ? "Done" : busy ? "Stop setup" : "Close"}
        </button>
      }
      labelledBy="add-phone-title"
      onClose={closeSetup}
      title={phoneName ?? "Add a phone"}
    >
      <Stage {...stage()} />
    </Dialog>
  );
}

/** Whose move it is: Opensteer's, the person's, or nobody's because setup ended. */
type Tone = "working" | "you" | "done" | "problem";

interface StageProps {
  readonly actions?: ReactNode;
  /** Shown between the words and the actions: a list to pick from, or how-to. */
  readonly body?: ReactNode;
  /** Where the person acts, said above the title while setup waits on them. */
  readonly cue?: string;
  readonly detail?: ReactNode;
  readonly icon?: IconName;
  /** Which of setup's stages it is in, while it runs. */
  readonly step?: number;
  readonly title: string;
  readonly tone: Tone;
}

/**
 * The one thing happening now. Whose move it is reads from the glyph's shape
 * and the words, never from color or motion alone: Opensteer working is a
 * spinner with nothing to press, and the person's turn names where to act or
 * offers the buttons that answer it. It stays mounted from phase to phase so
 * its words are one live region a screen reader follows.
 */
function Stage({ actions, body, cue, detail, icon, step, title, tone }: StageProps) {
  const ref = useRef<HTMLElement | null>(null);
  // The button just pressed can leave with the phase it belonged to; focus
  // stays in the dialog so Escape and Tab still reach it.
  useEffect(() => {
    if (document.activeElement === document.body) ref.current?.focus();
  }, [title]);
  const glyph =
    icon ?? (tone === "done" ? "check-circle" : tone === "problem" ? "alert-circle" : "phone");
  return (
    <section className={`phone-setup phone-setup--${tone}`} ref={ref} tabIndex={-1}>
      <span aria-hidden="true" className="phone-setup__glyph">
        {tone === "working" ? <span className="spinner" /> : <Icon name={glyph} />}
      </span>
      <div className="phone-setup__words" role="status">
        {cue ? <p className="phone-setup__cue">{cue}</p> : null}
        <h3 className="phone-setup__title">{title}</h3>
        {detail ? <p className="phone-setup__detail">{detail}</p> : null}
      </div>
      {body}
      {actions ? <div className="phone-setup__actions">{actions}</div> : null}
      {step === undefined ? null : (
        <ol aria-hidden="true" className="phone-setup__rail">
          {setupStages.map((steps, index) => (
            <li
              className={index < step ? "is-done" : index === step ? "is-current" : undefined}
              key={steps[0]}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** Setup's stages on the rail; reaching the phone and reading it are the first. */
const setupStages: readonly (readonly WizardStep[])[] = [
  ["connect", "authorize", "check"],
  ["install"],
  ["configure"],
  ["pair"],
];

function stageIndex(step: WizardStep): number {
  return setupStages.findIndex((steps) => steps.includes(step));
}

function wizardStep(step: Exclude<AgentPhoneSetupStep, { readonly step: "done" }>): WizardStep {
  switch (step.step) {
    case "inspect":
      return "check";
    case "install":
      return "install";
    case "configure":
      return "configure";
    case "pair":
      return "pair";
  }
}

function runningStage(
  step: WizardStep,
  phone: AgentPhoneFacts | null,
  deploymentName: string,
): StageProps {
  // ADB asks this only when the phone doesn't yet trust this computer.
  if (step === "authorize") {
    return {
      cue: "On the phone",
      detail: "Unlock it if the screen is off, then allow USB debugging.",
      step: stageIndex(step),
      title: "Tap Allow on the phone",
      tone: "you",
    };
  }
  const titles: Readonly<Record<Exclude<WizardStep, "authorize">, string>> = {
    check: phone ? `Checking ${phone.model}` : "Checking the phone",
    configure: "Setting up Agent Phone",
    connect: "Connecting to the phone",
    install: "Installing Agent Phone",
    pair: `Joining ${deploymentName}`,
  };
  return { step: stageIndex(step), title: titles[step], tone: "working" };
}

function readyStage({
  deploymentKind,
  desktop,
  homeName,
  note,
  onConnect,
  phoneName,
}: {
  readonly deploymentKind: "personal" | "server" | null;
  readonly desktop: boolean;
  readonly homeName: string;
  readonly note: ConnectNote | null;
  readonly onConnect: () => void;
  readonly phoneName: string | null;
}): StageProps {
  const noted = note ? connectNote(note, desktop) : null;
  return {
    actions: (
      <button className="btn btn--primary" onClick={onConnect} type="button">
        Choose the phone
      </button>
    ),
    body: phoneName ? null : (
      <div className="phone-setup__more">
        <details>
          <summary>Turn on USB debugging</summary>
          <p>
            In Settings → About phone, tap Build number seven times. Then turn on Developer options
            → USB debugging.
          </p>
        </details>
        {deploymentKind === "personal" ? (
          <p>
            Needs remote access on for {homeName}.{" "}
            <Link to="/settings/devices">Open Remote access</Link>
          </p>
        ) : null}
      </div>
    ),
    detail:
      noted?.detail ??
      (phoneName
        ? "Setup brings Agent Phone up to date and finishes anything left undone. The phone keeps its access."
        : "Android 11 or newer, with USB debugging on. Agents use its whole screen, so not the phone you carry."),
    icon: noted ? "alert-circle" : "phone",
    title:
      noted?.title ?? (phoneName ? "Plug it into this computer" : "Plug in a spare Android phone"),
    tone: "you",
  };
}

/** Why the last attempt to reach the phone ended, and what gets past it. */
function connectNote(
  note: ConnectNote,
  desktop: boolean,
): { readonly detail: string; readonly title: string } {
  switch (note) {
    case "busy":
      return {
        detail: desktop
          ? "Close its other phone-control session, then choose the phone again."
          : "Close the other phone-control session and choose again, or try setup in Opensteer Desktop.",
        title: "Another program is using the phone",
      };
    case "not-chosen":
      return desktop
        ? {
            detail: "If it’s plugged in, turn on USB debugging or try a cable that carries data.",
            title: "No phone found",
          }
        : {
            detail:
              "If yours wasn’t listed, turn on USB debugging or try a cable that carries data.",
            title: "No phone was chosen",
          };
    case "unauthorized":
      return {
        detail: "Unlock it, choose it again, and tap Allow when it asks.",
        title: "The phone didn’t allow USB debugging",
      };
  }
}

/** Several phones are plugged in; the desktop asks which one. */
function choiceStage(
  choice: DesktopUsbDeviceChoice,
  onAnswer: (deviceId: string | null) => void,
): StageProps {
  return {
    actions: (
      <button className="btn btn--small" onClick={() => onAnswer(null)} type="button">
        None of these
      </button>
    ),
    body: (
      <div className="card phone-setup__choices">
        {choice.devices.map((candidate) => (
          <div className="card__row" key={candidate.deviceId}>
            <span className="card__row-glyph">
              <Icon name="phone" />
            </span>
            <span className="card__row-body">
              <span className="card__row-title">{candidate.name ?? "Android phone"}</span>
              {candidate.serialNumber ? (
                <span className="card__row-detail">Serial {candidate.serialNumber}</span>
              ) : null}
            </span>
            <span className="card__row-actions">
              <button
                className="btn btn--small btn--primary"
                onClick={() => onAnswer(candidate.deviceId)}
                type="button"
              >
                Choose
              </button>
            </span>
          </div>
        ))}
      </div>
    ),
    cue: "Your turn",
    title: "Which phone?",
    tone: "you",
  };
}

/** Setup's question before it erases or unpairs anything on the phone; keeping is the default. */
function confirmStage(
  question: Question,
  step: WizardStep,
  deploymentName: string,
  onAnswer: (confirmed: boolean) => void,
): StageProps {
  const uninstall = question.kind === "uninstall";
  return {
    actions: (
      <>
        <button className="btn btn--danger" onClick={() => onAnswer(true)} type="button">
          {uninstall ? "Remove it" : "Unpair it"}
        </button>
        <button autoFocus className="btn" onClick={() => onAnswer(false)} type="button">
          Keep it
        </button>
      </>
    ),
    cue: "Your turn",
    detail: uninstall
      ? "This phone has a copy signed by someone else, which Android won’t replace. Removing it erases that app and everything it kept on the phone."
      : `It’s paired with ${question.hostUrl}. Unpairing stops that Opensteer’s agents from using it.`,
    icon: "alert-circle",
    step: stageIndex(step),
    title: uninstall
      ? "Remove the other Agent Phone app?"
      : `Move this phone to ${deploymentName}?`,
    tone: "you",
  };
}

/** What stopped setup, in words for the person holding the phone. */
function issueText(
  issue: AgentPhoneSetupIssue,
  names: { readonly deploymentName: string; readonly homeName: string },
): string {
  const detail = issue.detail ? ` ${issue.detail}` : "";
  switch (issue.code) {
    case "needs-update":
      return issue.detail ?? "Update Agent Phone on this phone over USB.";
    case "android-too-old":
      return `Opensteer Agent Phone needs Android 11 or newer. This phone has ${issue.detail ?? "an older Android"}.`;
    case "artifact-invalid":
      return `This Opensteer’s copy of the Agent Phone app didn’t check out, so nothing was set up.${detail}`;
    case "signature-mismatch":
      return "The other build of Opensteer Agent Phone is still on the phone, and Android won’t replace it. Remove it to continue.";
    case "install-failed":
      return `Android didn’t install the app:${detail}`;
    case "accessibility-failed":
    case "accessibility-off":
      return `Android didn’t turn on the app’s accessibility service.${detail} On the phone, open Settings → Accessibility → Opensteer Agent Phone, turn it on, then try again.`;
    case "configure-failed":
      return `The phone didn’t accept a setting setup needs.${detail}`;
    case "phone-app-refused":
      return `Opensteer Agent Phone on the phone turned down the pairing.${detail} Try again; if it keeps happening, remove the app from the phone and add it again.`;
    case "phone-app-unresponsive":
      return `Opensteer Agent Phone isn’t answering on the phone.${detail}`;
    case "paired-elsewhere":
      return `This phone already works for another Opensteer${issue.detail ? ` (${issue.detail})` : ""}. It joins this one only once it’s unpaired there.`;
    case "remote-access-off":
      return `Turn on remote access for ${names.homeName}, so the phone can reach it from wherever it is.`;
    case "host-unreachable":
      return `The phone can’t reach ${names.deploymentName}.${detail} Check that it’s on Wi-Fi or mobile data.`;
    case "host-mismatch":
      return `Something other than ${names.deploymentName} answered at its address, so the phone didn’t join.${detail}`;
    case "enrollment-expired":
      return "The phone’s join code ran out before it could be used.";
    case "enrollment-refused":
      return `${names.deploymentName} didn’t let the phone join.${detail}`;
    case "removed":
      return "This phone was removed from Opensteer. Try again to add it back.";
    case "pairing-timed-out":
      return `The phone didn’t finish joining ${names.deploymentName}. Check that it’s online.`;
    case "protocol-error":
      return `This phone and ${names.deploymentName} couldn’t understand each other.${detail} Try again: setup installs the Agent Phone app that comes with this Opensteer.`;
    case "failed":
      return `Setup didn’t finish on the phone.${detail}`;
  }
}
