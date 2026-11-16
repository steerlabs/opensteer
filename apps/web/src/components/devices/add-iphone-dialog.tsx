import { DeviceIdSchema, type DeploymentId } from "@opensteer/core";
import {
  mutationIdempotencyKey,
  type HostClient,
  type HostSnapshot,
  type IphoneSetupPort,
} from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import {
  DesktopIphoneSetupReasonSchema,
  type DesktopIphoneSetupReason,
  type DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";
import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router";
import { SetupStage, type SetupStageProps } from "../computers/setup-stage.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { deviceRoute } from "./device-routes.js";
import { iphoneSetupWords, type IphoneSetupWords } from "./iphone-setup-words.js";

type Status = DesktopIphoneSetupStatus;
type Candidate = Status["candidates"][number];
/** What Opensteer is doing for the person right now; nothing is pressable meanwhile. */
type Working = "begin" | "choose" | "check" | Status["step"];

/** Steps Opensteer carries on with by itself while nothing stands in the way. */
const automaticSteps = ["trust", "developer-mode", "prepare", "observe"] as const;
const rail: readonly (readonly Status["step"][])[] = [
  ["choose"],
  ["trust"],
  ["developer-mode"],
  ["prepare", "observe"],
  ["attach", "confirm"],
];
/** How long this Mac may take to report it took the iPhone on before the person is asked. */
const confirmDeadlineMs = 30_000;
const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;

/**
 * Adding an iPhone whose screen this Mac controls, over USB. Setup runs in
 * Opensteer on this Mac (the port); the dialog shows its current step in the
 * person's words, carries on by itself while nothing is in the way, and stops
 * with one clear action when the iPhone, this Mac or the Host needs something.
 * Closing it cancels setup.
 */
export function AddIphoneDialog({
  client,
  deploymentId,
  deploymentName,
  onClose,
  port,
}: {
  readonly client: HostClient;
  readonly deploymentId: DeploymentId;
  readonly deploymentName: string;
  readonly onClose: () => void;
  readonly port: IphoneSetupPort;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [working, setWorking] = useState<Working | null>("begin");
  const [thrown, setThrown] = useState<DesktopIphoneSetupReason | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [renameFailed, setRenameFailed] = useState(false);
  const [slow, setSlow] = useState(false);
  const machines = useHostSelector(client, selectMachines);
  const setupId = useRef<string | null>(null);
  // Bumped when the dialog closes, so a reply that lands afterwards changes nothing.
  const epoch = useRef(0);
  const closed = useRef(false);
  const workingNow = useRef(working);
  workingNow.current = working;
  const nameId = useId();

  async function run(what: Working, call: () => Promise<Status>): Promise<Status | null> {
    const mine = epoch.current;
    setWorking(what);
    setThrown(null);
    try {
      const next = await call();
      if (epoch.current !== mine) {
        // Setup that began as the dialog closed is still the Mac's to cancel.
        if (closed.current) void port.cancel({ setupId: next.setupId }).catch(() => undefined);
        return null;
      }
      setupId.current = next.setupId;
      setStatus(next);
      return next;
    } catch (error) {
      if (epoch.current === mine) setThrown(thrownReason(error));
      return null;
    } finally {
      if (epoch.current === mine) setWorking(null);
    }
  }

  function begin() {
    setChosen(null);
    setSlow(false);
    void run("begin", () => port.begin({ deploymentId }));
  }

  useEffect(() => {
    closed.current = false;
    begin();
    return () => {
      closed.current = true;
      epoch.current += 1;
      const id = setupId.current;
      setupId.current = null;
      if (id) void port.cancel({ setupId: id }).catch(() => undefined);
    };
    // One setup per open dialog; the port and deployment are fixed while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!status || working || thrown || status.reason) return;
    const step = automaticSteps.find((candidate) => candidate === status.step);
    if (step) void run(step, () => port.advance({ setupId: status.setupId, step }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, working, thrown]);

  // This Mac takes the iPhone on after the Host adds it; the Host's device list
  // changes when it does, which is when to ask again.
  const confirming = status?.step === "confirm";
  useEffect(() => {
    if (!confirming || !status || workingNow.current) return;
    void run("check", () => port.status({ setupId: status.setupId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, machines]);
  useEffect(() => {
    if (!confirming) return;
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), confirmDeadlineMs);
    return () => clearTimeout(timer);
  }, [confirming]);

  function choose(candidate: Candidate) {
    if (!status) return;
    setChosen(candidate);
    void run("choose", () =>
      port.choose({ setupId: status.setupId, candidateId: candidate.candidateId }),
    );
  }

  async function attach(current: Status) {
    const wanted = name?.trim();
    const next = await run("attach", () => port.attach({ setupId: current.setupId }));
    const deviceId = DeviceIdSchema.safeParse(next?.deviceId);
    if (!wanted || !deviceId.success) return;
    try {
      await client.dispatch({
        idempotencyKey: mutationIdempotencyKey("iphone-name"),
        machineId: deviceId.data,
        name: wanted,
        type: "machine.rename",
      });
    } catch {
      setRenameFailed(true);
    }
  }

  function check(current: Status) {
    setSlow(false);
    if (current.step === "choose" || current.step === "confirm" || current.step === "done")
      void run("check", () => port.status({ setupId: current.setupId }));
    else if (current.step === "attach") void attach(current);
    else {
      const step = current.step;
      void run(step, () => port.advance({ setupId: current.setupId, step }));
    }
  }

  function close() {
    onClose();
  }

  const phoneName = chosen?.name || "the iPhone";
  const displayName = name?.trim() || chosen?.name || "iPhone";

  function stage(): SetupStageProps {
    // A late Mac is the person's to know about even while another check is out.
    if (working && !(working === "check" && slow))
      return workingStage(working, status, phoneName, deploymentName);
    const reason = shownReason(status, thrown);
    const words = reason
      ? iphoneSetupWords(reason, {
          deploymentName,
          osVersion: chosen?.osVersion ?? null,
          step: status?.step ?? "choose",
        })
      : null;
    // Without a setup on the Mac, the way forward is a new one.
    if (!status || (words && words.recovery !== "check"))
      return reasonStage(
        words ?? iphoneSetupWords("cancelled", { deploymentName, osVersion: null, step: "choose" }),
        {
          onCheck: begin,
          recovery: words?.recovery === "none" ? "none" : "restart",
          step: undefined,
        },
      );
    if (words && status.step !== "choose")
      return reasonStage(words, {
        onCheck: () => check(status),
        recovery: "check",
        step: stageIndex(status.step),
      });
    switch (status.step) {
      case "choose":
        return chooseStage(status, reason, chosen, deploymentName, choose, () => check(status));
      case "attach":
        return {
          actions: (
            <button className="btn btn--primary" onClick={() => void attach(status)} type="button">
              Add iPhone
            </button>
          ),
          body: (
            <div className="phone-setup__more iphone-setup__name">
              <label className="field" htmlFor={nameId}>
                <span className="field__label">Name</span>
                <input
                  className="text-input"
                  id={nameId}
                  maxLength={120}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={chosen?.name || "iPhone"}
                  value={name ?? chosen?.name ?? ""}
                />
              </label>
              <p>It works while it’s plugged into this Mac.</p>
            </div>
          ),
          detail: `It answered, and its screen came through. Name it and add it to ${deploymentName}.`,
          icon: "eye",
          step: stageIndex("attach"),
          title: "This Mac can see the iPhone’s screen",
          tone: "you",
        };
      case "confirm":
        return slow
          ? reasonStage(
              iphoneSetupWords("assignment-pending", {
                deploymentName,
                osVersion: null,
                step: "confirm",
              }),
              { onCheck: () => check(status), recovery: "check", step: stageIndex("confirm") },
            )
          : workingStage("confirm", status, phoneName, deploymentName);
      case "done":
        return {
          actions: status.deviceId ? (
            <Link className="btn btn--primary" onClick={close} to={deviceRoute(status.deviceId)}>
              Open the iPhone’s page
            </Link>
          ) : null,
          body: (
            <div className="phone-setup__more">
              <p>
                Agents can’t use it until you allow them on its page. Opensteer reaches it only
                while it’s plugged into this Mac.
              </p>
              {renameFailed ? (
                <p className="notice" role="status">
                  Its name didn’t save. Rename it on its page.
                </p>
              ) : null}
            </div>
          ),
          title: `${renameFailed ? (chosen?.name ?? "The iPhone") : displayName} is added`,
          tone: "done",
        };
      default:
        return workingStage(status.step, status, phoneName, deploymentName);
    }
  }

  const done = status?.step === "done";
  return (
    <Dialog
      footer={
        <button className="btn" onClick={close} type="button">
          {done ? "Done" : "Cancel"}
        </button>
      }
      labelledBy="add-iphone-title"
      onClose={close}
      title={<span id="add-iphone-title">Add an iPhone</span>}
    >
      <SetupStage {...stage()} steps={rail.length} />
    </Dialog>
  );
}

/**
 * The reason setup is held up, if any. No phone stops being one once one is
 * listed, and the Mac taking the iPhone on is something to wait for, not fix,
 * until it runs late.
 */
function shownReason(
  status: Status | null,
  thrown: DesktopIphoneSetupReason | null,
): DesktopIphoneSetupReason | null {
  if (thrown) return thrown;
  if (!status?.reason) return null;
  if (status.reason === "no-phone" && status.candidates.length > 0) return null;
  if (status.reason === "assignment-pending" && status.step === "confirm") return null;
  return status.reason;
}

function stageIndex(step: Status["step"]): number | undefined {
  const index = rail.findIndex((steps) => steps.includes(step));
  return index < 0 ? undefined : index;
}

function workingStage(
  working: Working,
  status: Status | null,
  phoneName: string,
  deploymentName: string,
): SetupStageProps {
  const step = status ? stageIndex(status.step) : undefined;
  switch (working) {
    case "begin":
      return { title: "Looking for iPhones on this Mac", tone: "working" };
    case "choose":
      return { step, title: `Connecting to ${phoneName}`, tone: "working" };
    case "trust":
      return {
        detail: "If it asks, unlock it, tap Trust and enter its passcode.",
        step,
        title: `Asking ${phoneName} to trust this Mac`,
        tone: "working",
      };
    case "developer-mode":
      return { step, title: "Checking Developer Mode", tone: "working" };
    case "prepare":
      return {
        detail: "The first time can take a minute.",
        step,
        title: "Preparing developer services",
        tone: "working",
      };
    case "observe":
      return { step, title: "Taking a first look at the screen", tone: "working" };
    case "attach":
    case "confirm":
      return { step, title: `Adding it to ${deploymentName}`, tone: "working" };
    case "check":
      return status?.step === "confirm"
        ? { step, title: `Adding it to ${deploymentName}`, tone: "working" }
        : { step, title: "Checking again", tone: "working" };
    default:
      return { step, tone: "working", title: "Finishing" };
  }
}

function reasonStage(
  words: IphoneSetupWords,
  options: {
    readonly onCheck: () => void;
    readonly recovery: IphoneSetupWords["recovery"];
    readonly step: number | undefined;
  },
): SetupStageProps {
  return {
    actions:
      options.recovery === "none" ? null : (
        <button className="btn btn--primary" onClick={options.onCheck} type="button">
          {options.recovery === "restart" ? "Start again" : "Check again"}
        </button>
      ),
    body: words.instructions ? (
      <div className="phone-setup__more">
        <details>
          <summary>Open instructions</summary>
          <ol className="iphone-setup__steps">
            {words.instructions.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        </details>
      </div>
    ) : null,
    ...(words.cue ? { cue: words.cue } : {}),
    detail: words.detail,
    ...(words.yours ? {} : { icon: "alert-circle" as const }),
    ...(options.step === undefined ? {} : { step: options.step }),
    title: words.title,
    tone: words.yours ? "you" : "problem",
  };
}

/** Plugged-in iPhones to pick from; one is never picked for the person. */
function chooseStage(
  status: Status,
  reason: DesktopIphoneSetupReason | null,
  chosen: Candidate | null,
  deploymentName: string,
  onChoose: (candidate: Candidate) => void,
  onCheck: () => void,
): SetupStageProps {
  if (status.candidates.length === 0) {
    const words = iphoneSetupWords(reason ?? "no-phone", {
      deploymentName,
      osVersion: null,
      step: "choose",
    });
    return {
      ...reasonStage(words, { onCheck, recovery: words.recovery, step: 0 }),
      icon: words.yours ? "plug" : "alert-circle",
    };
  }
  const notice = reason
    ? iphoneSetupWords(reason, {
        deploymentName,
        osVersion: chosen?.osVersion ?? null,
        step: "choose",
      })
    : null;
  return {
    actions: (
      <button className="btn btn--small" onClick={onCheck} type="button">
        Check again
      </button>
    ),
    body: (
      <div className="card phone-setup__choices">
        {status.candidates.map((candidate) => {
          const blocked = candidate.reason
            ? iphoneSetupWords(candidate.reason, {
                deploymentName,
                osVersion: candidate.osVersion,
                step: "choose",
              })
            : null;
          return (
            <div className="card__row" key={candidate.candidateId}>
              <span className="card__row-glyph">
                <Icon name="phone" />
              </span>
              <span className="card__row-body">
                <span className="card__row-title">{candidate.name || "iPhone"}</span>
                <span className="card__row-detail">
                  {blocked
                    ? blocked.title
                    : [candidate.model, candidate.osVersion && `iOS ${candidate.osVersion}`]
                        .filter(Boolean)
                        .join(" · ")}
                </span>
              </span>
              <span className="card__row-actions">
                <button
                  aria-label={`Choose ${candidate.name || "iPhone"}`}
                  className="btn btn--small btn--primary"
                  disabled={blocked !== null}
                  onClick={() => onChoose(candidate)}
                  type="button"
                >
                  Choose
                </button>
              </span>
            </div>
          );
        })}
      </div>
    ),
    cue: "Your turn",
    detail: notice
      ? `${notice.title}. ${notice.detail}`
      : "Plugged into this Mac with a cable. It must stay plugged in while agents use it.",
    ...(notice ? { icon: "alert-circle" as const } : {}),
    step: 0,
    title: "Which iPhone?",
    tone: "you",
  };
}

/** Electron's invoke keeps only an error's message, which the Mac's setup sets to its reason. */
function thrownReason(error: unknown): DesktopIphoneSetupReason {
  const message = error instanceof Error ? error.message : "";
  const parsed = DesktopIphoneSetupReasonSchema.safeParse(message.split(/[:\s]+/u).pop());
  return parsed.success ? parsed.data : "native-service-failed";
}
