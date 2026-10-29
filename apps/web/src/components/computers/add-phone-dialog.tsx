import {
  AgentPhoneEnrollments,
  agentPhoneAdb,
  agentPhoneSetupHost,
  setupAgentPhone,
  type AgentPhoneArtifact,
  type AgentPhoneFacts,
  type AgentPhoneSetupIssue,
  type AgentPhoneSetupStep,
} from "@opensteer/agent-phone-setup";
import {
  agentPhoneCredentialStore,
  agentPhoneUsb,
  chooseAgentPhone,
  connectAgentPhone,
  grantedAgentPhones,
  type AgentPhoneUsbDevice,
} from "@opensteer/agent-phone-setup/webusb";
import { mutationIdempotencyKey, type HostClient } from "@opensteer/client/host";
import type { DesktopUsbDeviceChoice, OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { loadAgentPhoneArtifact } from "../../computers/agent-phone-setup.js";
import { actionErrorMessage } from "../../ui-utils.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";

/**
 * Setting an Android phone up over USB, once.
 *
 * The phone is plugged into the computer this page is open on; everything
 * after the person picks it and allows USB debugging happens without them.
 * The steps are the setup engine's, named the way the person experiences them.
 */

type WizardStep = "connect" | "authorize" | "check" | "install" | "configure" | "pair";

/** Why the last attempt to reach the phone ended, shown above the requirements. */
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
      const connection = await connectAgentPhone(chosen, {
        credentialStore: agentPhoneCredentialStore(),
        onAuthorizePrompt: () => {
          if (isCurrent(session)) {
            setPhase({ kind: "running", question: null, step: "authorize" });
          }
        },
        signal: abort.signal,
      });
      if (!isCurrent(session)) {
        if (connection.kind === "connected") await connection.adb.close().catch(() => undefined);
        return;
      }
      if (connection.kind !== "connected") {
        setPhase({ kind: "ready", note: connection.kind });
        return;
      }
      session.close = () => {
        session.close = () => undefined;
        void connection.adb.close().catch(() => undefined);
      };
      const result = await setupAgentPhone({
        adb: agentPhoneAdb(connection.adb),
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

  const busy = phase.kind === "running" || phase.kind === "choosing";
  const title = phoneName ? `Plug in ${phoneName}` : "Add a phone";
  return (
    <Dialog
      footer={
        <button className="btn" onClick={closeSetup} type="button">
          {phase.kind === "done" ? "Done" : busy ? "Stop setup" : "Close"}
        </button>
      }
      labelledBy="add-phone-title"
      onClose={closeSetup}
      title={title}
    >
      {phase.kind === "unsupported" ? (
        <p className="notice notice--warn" role="alert">
          Adding a phone needs Chrome or the Opensteer desktop app, which can reach a phone over
          USB. This browser can’t.
        </p>
      ) : phase.kind === "no-artifact" ? (
        <p className="notice notice--warn" role="alert">
          This Opensteer build doesn’t include the Agent Phone app, so it can’t set up a phone.
        </p>
      ) : phase.kind === "loading" ? (
        <p className="section__hint">Getting the Agent Phone app ready…</p>
      ) : phase.kind === "ready" ? (
        <Requirements
          deploymentKind={deploymentKind}
          homeName={homeName}
          note={phase.note}
          onConnect={() => void choose()}
          phoneName={phoneName ?? null}
        />
      ) : phase.kind === "choosing" ? (
        <UsbChoice
          choice={phase.choice}
          onAnswer={(deviceId) => {
            if (!phase.choice || !desktopBridge) return;
            const session = attempt.current;
            if (!session) return;
            void desktopBridge
              .chooseUsbDevice({ choiceId: phase.choice.choiceId, deviceId })
              .catch((reason: unknown) => {
                if (isCurrent(session))
                  setPhase({ kind: "failed", message: actionErrorMessage(reason) });
              });
            setPhase({ choice: null, kind: "choosing" });
          }}
        />
      ) : phase.kind === "running" ? (
        <>
          {phase.question ? <Confirm onAnswer={answered} question={phase.question} /> : null}
          <Progress deploymentName={deploymentName} step={phase.step} />
        </>
      ) : phase.kind === "disconnected" ? (
        <p className="notice notice--warn" role="status">
          The phone was unplugged. Plug it back in to continue; setup picks up where it stopped.
        </p>
      ) : phase.kind === "done" ? (
        <section className="add-computer__step">
          <h3>{phone ? `${phone.model} is ready` : "The phone is ready"}</h3>
          <p className="section__hint">
            Agents in {deploymentName} can use it while it is online. You can change their access
            from the phone’s page. Tasks in a Workspace already allowed to use it aren’t asked
            again.
          </p>
          <Link
            className="btn btn--primary btn--small"
            onClick={closeSetup}
            to={`/settings/computers/${encodeURIComponent(phase.runnerId)}`}
          >
            Open the phone’s page
          </Link>
        </section>
      ) : phase.kind === "issue" ? (
        <IssueNotice
          deploymentName={deploymentName}
          homeName={homeName}
          issue={phase.issue}
          onClose={closeSetup}
          onRetry={retry}
        />
      ) : (
        <div className="notice notice--error" role="alert">
          <p>{phase.message}</p>
          <div className="form-actions">
            <button className="btn btn--small" onClick={retry} type="button">
              Try again
            </button>
          </div>
        </div>
      )}

      {phone?.secureLock ? (
        <p className="notice notice--warn">
          Agents unlock this phone with the PIN you give them; after a restart, unlock it once
          yourself.
        </p>
      ) : null}
    </Dialog>
  );
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

function Requirements({
  deploymentKind,
  homeName,
  note,
  onConnect,
  phoneName,
}: {
  readonly deploymentKind: "personal" | "server" | null;
  readonly homeName: string;
  readonly note: ConnectNote | null;
  readonly onConnect: () => void;
  readonly phoneName: string | null;
}) {
  return (
    <section className="add-computer__step">
      {note ? (
        <p className="notice notice--warn" role="alert">
          {connectNoteText[note]}
        </p>
      ) : null}
      <h3>{phoneName ? `Plug ${phoneName} into this computer` : "Before you start"}</h3>
      {phoneName ? (
        <p className="section__hint">
          This installs the Agent Phone app that comes with this Opensteer and finishes anything
          setup left undone. The phone keeps its access and its place here.
        </p>
      ) : (
        <ol className="add-computer__steps">
          <li>
            A spare Android phone with Android 11 or newer. Agents use its whole screen, so it
            shouldn’t be the phone you carry.
          </li>
          <li>
            USB debugging turned on: in Settings → About phone, tap Build number seven times, then
            turn on Developer options → USB debugging.
          </li>
          {deploymentKind === "personal" ? (
            <li>
              Remote access on for {homeName}, so the phone can reach it from anywhere.{" "}
              <Link to="/settings/devices">Open Remote access</Link>
            </li>
          ) : null}
          <li>A USB cable from the phone to this computer.</li>
        </ol>
      )}
      <div className="form-actions">
        <button className="btn btn--primary" onClick={onConnect} type="button">
          Choose the phone
        </button>
      </div>
    </section>
  );
}

const connectNoteText: Readonly<Record<ConnectNote, string>> = {
  busy: "Another program is using this phone’s USB debugging, usually Android Studio or adb. Quit it, or run adb kill-server, then choose the phone again.",
  "not-chosen":
    "No phone was chosen. If yours wasn’t in the list, USB debugging is off or the cable only charges: turn USB debugging on, then choose the phone again.",
  unauthorized:
    "The phone didn’t allow USB debugging. Unlock it, tap Allow when it asks “Allow USB debugging?”, then choose it again.",
};

/** Several phones are plugged in; the desktop asks which one. */
function UsbChoice({
  choice,
  onAnswer,
}: {
  readonly choice: DesktopUsbDeviceChoice | null;
  readonly onAnswer: (deviceId: string | null) => void;
}) {
  if (!choice) {
    return <p className="section__hint">Choose the phone in the list that opened.</p>;
  }
  return (
    <section className="add-computer__step">
      <h3>Which phone?</h3>
      <div className="card">
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
      <div className="form-actions">
        <button className="btn btn--small" onClick={() => onAnswer(null)} type="button">
          None of these
        </button>
      </div>
    </section>
  );
}

function Confirm({
  onAnswer,
  question,
}: {
  readonly onAnswer: (confirmed: boolean) => void;
  readonly question: Question;
}) {
  return (
    <section className="add-computer__step" role="alertdialog" aria-label="Confirm">
      {question.kind === "uninstall" ? (
        <>
          <h3>Remove the other Agent Phone app?</h3>
          <p className="section__hint">
            This phone has a build of Opensteer Agent Phone signed by someone else, and Android
            won’t replace it. Removing it erases that app and everything it kept on the phone.
          </p>
        </>
      ) : (
        <>
          <h3>This phone works for another Opensteer</h3>
          <p className="section__hint">
            It’s paired with {question.hostUrl}. Unpairing it there stops agents of that Opensteer
            from using it; then it joins this one.
          </p>
        </>
      )}
      <div className="form-actions">
        <button className="btn btn--danger btn--small" onClick={() => onAnswer(true)} type="button">
          {question.kind === "uninstall" ? "Remove it" : "Unpair it"}
        </button>
        <button className="btn btn--small" onClick={() => onAnswer(false)} type="button">
          Keep it
        </button>
      </div>
    </section>
  );
}

function Progress({
  deploymentName,
  step,
}: {
  readonly deploymentName: string;
  readonly step: WizardStep;
}) {
  const steps: readonly { readonly label: string; readonly step: WizardStep }[] = [
    { label: "Reach the phone", step: "connect" },
    { label: "Allow USB debugging on the phone", step: "authorize" },
    { label: "Check the phone", step: "check" },
    { label: "Install Opensteer Agent Phone", step: "install" },
    { label: "Turn on its accessibility service", step: "configure" },
    { label: `Join ${deploymentName}`, step: "pair" },
  ];
  const current = steps.findIndex((entry) => entry.step === step);
  return (
    <div className="computers-readiness" role="status">
      {steps.map((entry, index) => (
        <div className="computers-readiness__line" key={entry.step}>
          <span
            className={`status-dot ${
              index < current
                ? "status-dot--running"
                : index === current
                  ? "status-dot--waiting"
                  : "status-dot--idle"
            }`}
          />
          <strong>{entry.label}</strong>
          <span>{index < current ? "Done" : index === current ? currentText(step) : ""}</span>
        </div>
      ))}
    </div>
  );
}

function currentText(step: WizardStep): string {
  if (step === "authorize") return "Unlock the phone and tap Allow";
  return "Working…";
}

function IssueNotice({
  deploymentName,
  homeName,
  issue,
  onClose,
  onRetry,
}: {
  readonly deploymentName: string;
  readonly homeName: string;
  readonly issue: AgentPhoneSetupIssue;
  readonly onClose: () => void;
  readonly onRetry: () => void;
}) {
  return (
    <div className="notice notice--error" role="alert">
      <p>{issueText(issue, { deploymentName, homeName })}</p>
      <div className="form-actions">
        {issue.code === "remote-access-off" ? (
          <Link className="btn btn--small btn--primary" onClick={onClose} to="/settings/devices">
            Open Remote access
          </Link>
        ) : null}
        <button className="btn btn--small" onClick={onRetry} type="button">
          Try again
        </button>
      </div>
    </div>
  );
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
