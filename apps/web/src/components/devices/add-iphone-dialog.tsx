import { type DeploymentId } from "@opensteer/core";
import { type HostClient, type HostSnapshot, type IphoneSetupPort } from "@opensteer/client/host";
import type { IphoneScreenAttachCommand } from "@opensteer/protocol";
import { phoneScreenMac } from "@opensteer/client/integrations";
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
import { iphoneSetupWords, wifiRetryAction, type IphoneSetupWords } from "./iphone-setup-words.js";

type Status = DesktopIphoneSetupStatus;
type Candidate = Status["candidates"][number];
export type ExistingIphoneTarget = Extract<
  IphoneScreenAttachCommand["target"],
  { kind: "existing" }
>;
/** What Opensteer is doing for the person right now; nothing is pressable meanwhile. */
type Working = "begin" | "choose" | "check" | "skip-wifi" | Status["step"];

/** Steps Opensteer carries on with by itself while nothing stands in the way. */
const automaticSteps = ["trust", "developer-mode", "prepare", "observe"] as const;
const rail: readonly (readonly Status["step"][])[] = [
  ["choose"],
  ["trust"],
  ["developer-mode"],
  ["prepare", "observe"],
  ["wifi"],
  ["attach", "confirm"],
];
/** How long this Mac may take to report it took the iPhone on before the person is asked. */
const confirmDeadlineMs = 30_000;
const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;

/**
 * Adding an iPhone whose screen this Mac controls, over USB or the same Wi‑Fi. Setup runs in
 * Opensteer on this Mac (the port); the dialog shows its current step in the
 * person's words, carries on by itself while nothing is in the way, and stops
 * with one clear action when the iPhone, this Mac or the Host needs something.
 * Closing it cancels setup. With `existing`, it sets that iPhone up again
 * under its own name; the Host keeps its approvals, tab and Stops.
 */
export function AddIphoneDialog({
  client,
  deploymentId,
  deploymentName,
  existing,
  onClose,
  port,
}: {
  readonly client: HostClient;
  readonly deploymentId: DeploymentId;
  readonly deploymentName: string;
  readonly existing?: ExistingIphoneTarget;
  readonly onClose: () => void;
  readonly port: IphoneSetupPort;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [working, setWorking] = useState<Working | null>("begin");
  const [thrown, setThrown] = useState<DesktopIphoneSetupReason | null>(null);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [name, setName] = useState<string | null>(null);
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
    void run("begin", () =>
      port.begin({ deploymentId, ...(existing ? { target: existing } : {}) }),
    );
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
    const wanted = again ? "" : shownName.trim().slice(0, 120);
    await run("attach", () =>
      port.attach({ setupId: current.setupId, ...(wanted ? { name: wanted } : {}) }),
    );
  }

  function chooseWifi(current: Status, action: "enable" | "disable" | "pair" | "skip") {
    void run(action === "skip" ? "skip-wifi" : "wifi", () =>
      port.wifi({ setupId: current.setupId, action }),
    );
  }

  function check(current: Status) {
    setSlow(false);
    if (current.step === "choose" || current.step === "confirm" || current.step === "done")
      void run("check", () => port.status({ setupId: current.setupId }));
    else if (current.step === "attach") void attach(current);
    else if (current.step === "wifi")
      chooseWifi(current, wifiRetryAction(current.reason, "enable"));
    else {
      const step = current.step;
      void run(step, () => port.advance({ setupId: current.setupId, step }));
    }
  }

  function close() {
    onClose();
  }

  // A setup the Mac resumes may be for another iPhone than the one asked about.
  const target = status ? status.target : (existing ?? null);
  const again = target?.kind === "existing" ? target : null;
  const againName =
    (again && machines.find((machine) => machine.id === again.deviceId)?.name) || "the iPhone";
  const phoneName = chosen?.name || "the iPhone";
  const shownName = name ?? chosen?.name ?? "";
  const displayName = again ? againName : shownName.trim() || "iPhone";
  const adding = again ? `Connecting it to ${deploymentName}` : `Adding it to ${deploymentName}`;
  const added = status?.deviceId
    ? machines.find((machine) => machine.id === status.deviceId)
    : null;
  const macName = (added && phoneScreenMac(added)?.name) || "this Mac";

  function stage(): SetupStageProps {
    // A late Mac is the person's to know about even while another check is out.
    if (working && !(working === "check" && slow))
      return workingStage(working, status, phoneName, adding);
    const reason = shownReason(status, thrown);
    const words = reason
      ? iphoneSetupWords(reason, {
          deploymentName,
          osVersion: chosen?.osVersion ?? null,
          step: status?.step ?? "choose",
        })
      : null;
    if (status?.step === "wifi" && words?.recovery !== "restart")
      return wifiStage(status, words, phoneName, (action) => chooseWifi(status, action));
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
        return chooseStage(
          status,
          reason,
          chosen,
          deploymentName,
          again ? againName : null,
          choose,
          () => check(status),
        );
      case "attach":
        if (again)
          return {
            actions: (
              <button
                className="btn btn--primary"
                onClick={() => void attach(status)}
                type="button"
              >
                Connect it again
              </button>
            ),
            body: (
              <div className="phone-setup__more">
                <p>
                  {status.wifiEnabled
                    ? "It works while it’s plugged into this Mac or on the same Wi‑Fi as it."
                    : "It works while it’s plugged into this Mac."}
                </p>
              </div>
            ),
            detail: `It answered, and its screen came through. ${againName} keeps its name, approvals and tab.`,
            icon: "eye",
            step: stageIndex("attach"),
            title: "This Mac can see the iPhone’s screen",
            tone: "you",
          };
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
                  value={shownName}
                />
              </label>
              <p>
                {status.wifiEnabled
                  ? "It works while it’s plugged into this Mac or on the same Wi‑Fi as it."
                  : "It works while it’s plugged into this Mac."}
              </p>
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
          : workingStage("confirm", status, phoneName, adding);
      case "done":
        return {
          actions:
            status.deviceId && !again ? (
              <Link className="btn btn--primary" onClick={close} to={deviceRoute(status.deviceId)}>
                Open the iPhone’s page
              </Link>
            ) : null,
          body: (
            <div className="phone-setup__more">
              <p>
                {status.wifiEnabled
                  ? `It works while it’s plugged in or on the same Wi‑Fi as ${macName}.`
                  : `It works while it’s plugged into ${macName}.`}{" "}
                {again
                  ? "Agents can use it as you allowed before."
                  : "Agents can’t use it until you allow them on its page."}
              </p>
            </div>
          ),
          title: again ? `${displayName} is connected again` : `${displayName} is added`,
          tone: "done",
        };
      default:
        return workingStage(status.step, status, phoneName, adding);
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
      title={
        <span id="add-iphone-title">{again ? `Set up ${againName} again` : "Add an iPhone"}</span>
      }
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
  adding: string,
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
    case "wifi":
      return {
        detail: "If the iPhone asks, tap Trust and enter its passcode.",
        step,
        title: "Turning on Wi‑Fi access",
        tone: "working",
      };
    case "attach":
    case "confirm":
      return { step, title: adding, tone: "working" };
    case "check":
      return status?.step === "confirm"
        ? { step, title: adding, tone: "working" }
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
          {options.recovery === "restart" ? "Start again" : (words.action ?? "Check again")}
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

/**
 * The optional Wi‑Fi step: what it changes, and after a typed reason, the one
 * thing that fixes it. Going on with the cable alone is always a way out.
 */
function wifiStage(
  status: Status,
  words: IphoneSetupWords | null,
  phoneName: string,
  onWifi: (action: "enable" | "disable" | "pair" | "skip") => void,
): SetupStageProps {
  const pluggedIn = (primary: boolean) => (
    <button
      className={primary ? "btn btn--primary" : "btn"}
      onClick={() => onWifi("skip")}
      type="button"
    >
      Only when plugged in
    </button>
  );
  if (!words)
    return {
      actions: (
        <>
          <button className="btn btn--primary" onClick={() => onWifi("enable")} type="button">
            Use Wi‑Fi too
          </button>
          {pluggedIn(false)}
        </>
      ),
      body: (
        <div className="phone-setup__more">
          <p>If macOS asks to let Opensteer find devices on your network, allow it.</p>
        </div>
      ),
      detail: `After this, ${phoneName} works while it’s plugged into this Mac or on the same Wi‑Fi as it. Not on other networks or over cellular.`,
      icon: "wifi",
      step: stageIndex("wifi"),
      title: "Also use it over Wi‑Fi?",
      tone: "you",
    };
  const shown = reasonStage(words, {
    onCheck: () => onWifi(wifiRetryAction(status.reason, "enable")),
    recovery: words.recovery,
    step: stageIndex("wifi"),
  });
  return {
    ...shown,
    ...(words.yours ? { icon: "wifi" as const } : {}),
    actions:
      words.recovery === "none" ? (
        pluggedIn(true)
      ) : (
        <>
          {shown.actions}
          {pluggedIn(false)}
        </>
      ),
  };
}

/** Plugged-in iPhones to pick from; one is never picked for the person. */
function chooseStage(
  status: Status,
  reason: DesktopIphoneSetupReason | null,
  chosen: Candidate | null,
  deploymentName: string,
  againName: string | null,
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
      : "Plugged into this Mac with a cable for setup. You can add Wi‑Fi after the first screen check.",
    ...(notice ? { icon: "alert-circle" as const } : {}),
    step: 0,
    title: againName ? `Which iPhone is ${againName}?` : "Which iPhone?",
    tone: "you",
  };
}

/** Electron's invoke keeps only an error's message, which the Mac's setup sets to its reason. */
function thrownReason(error: unknown): DesktopIphoneSetupReason {
  const message = error instanceof Error ? error.message : "";
  const parsed = DesktopIphoneSetupReasonSchema.safeParse(message.split(/[:\s]+/u).pop());
  return parsed.success ? parsed.data : "native-service-failed";
}
