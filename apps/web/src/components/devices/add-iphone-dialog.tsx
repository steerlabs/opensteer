import { type DeploymentId } from "@opensteer/core";
import { type HostClient, type HostSnapshot, type IphoneSetupPort } from "@opensteer/client/host";
import {
  iphoneScreenKeepAwakeTip,
  phoneScreenMac,
  phoneUseView,
} from "@opensteer/client/integrations";
import { useHostSelector } from "@opensteer/client/react";
import type { IphoneScreenAttachCommand, MachineSummary } from "@opensteer/protocol";
import {
  DesktopIphoneSetupReasonSchema,
  type DesktopIphoneSetupReason,
  type DesktopIphoneSetupStatus,
} from "@opensteer/protocol/desktop";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { act, failureWords } from "../use-action.js";
import { useComputerAppData } from "../computer-apps/computer-apps-section.js";
import { SetupStage, type SetupStageProps } from "../computers/setup-stage.js";
import { Dialog } from "../dialog.js";
import { Icon } from "../icon.js";
import { OptionRow } from "../option-row.js";
import { deviceRoute } from "./device-routes.js";
import { setIphoneAgentAccess, type IphoneAgentAccess } from "./iphone-agent-access.js";
import { IphoneSetupNeeds, type NeedMarks } from "./iphone-setup-needs.js";
import {
  iphoneSetupWords,
  iphoneStageLabels,
  type IphoneSetupWords,
} from "./iphone-setup-words.js";

type Status = DesktopIphoneSetupStatus;
type Candidate = Status["candidates"][number];
export type ExistingIphoneTarget = Extract<
  IphoneScreenAttachCommand["target"],
  { kind: "existing" }
>;
/** The person's answer on its way to the Mac; nothing else is pressable meanwhile. */
type Sending = "begin" | "choose" | "help" | "wifi" | "add" | "retry" | "start-over";

const rail = Object.keys(iphoneStageLabels) as (keyof typeof iphoneStageLabels)[];
const selectMachines = (snapshot: HostSnapshot) => snapshot.machines;
const ignore = () => undefined;

/**
 * Adding an iPhone whose screen this Mac controls, over USB or the same Wi‑Fi.
 * Setup runs in Opensteer on this Mac and drives itself; the dialog is a view
 * of the status it pushes, and sends only the person's decisions. Closing it
 * cancels setup. With `existing`, it fixes that iPhone's setup under its own
 * name; the Host keeps its approvals, tab and Stops.
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
  const setup = useIphoneSetup(port, deploymentId, existing);
  const { status, sending, failure } = setup;
  const machines = useHostSelector(client, selectMachines);
  const [name, setName] = useState<string | null>(null);
  const decision = useRef<HTMLElement | null>(null);
  const nameId = useId();

  // The setup the Mac resumes may be for another iPhone than the one asked about.
  const target = status ? status.target : (existing ?? null);
  const again = target?.kind === "existing" ? target : null;
  const againMachine = again ? machines.find((machine) => machine.id === again.deviceId) : null;
  const againName = againMachine?.name || "the iPhone";
  // Named once: setting it up again attaches it, which mustn't retitle the dialog midway.
  const [reattaching] = useState(() => {
    const prior = existing ? machines.find((machine) => machine.id === existing.deviceId) : null;
    return prior ? phoneScreenMac(prior)?.attached === false : false;
  });
  const phoneName = status?.phone?.name || "your iPhone";
  const added = status?.deviceId
    ? (machines.find((machine) => machine.id === status.deviceId) ?? null)
    : null;
  const shownName = name ?? status?.suggestedName ?? status?.phone?.name ?? "";

  // A decision takes focus when it appears, so the keyboard lands on the answer.
  const decisionKey = status?.state === "decide" ? `${status.setupId}:${status.action}` : null;
  useEffect(() => {
    if (!decisionKey) return;
    const first = decision.current?.querySelector<HTMLElement>(
      "input:not([disabled]), button:not([disabled])",
    );
    first?.focus();
    if (first instanceof HTMLInputElement && first.type === "text") first.select();
  }, [decisionKey]);

  const busy = sending !== null;
  const help = (action: "get-xcode" | "open-xcode" | "open-local-network") => {
    if (status) setup.send("help", () => port.help({ setupId: status.setupId, action }));
  };
  const words = (reason: DesktopIphoneSetupReason) =>
    iphoneSetupWords(reason, {
      deploymentName,
      osVersion: status?.phone?.osVersion ?? null,
      stage: status?.stage ?? "mac",
    });

  function stage(): SetupStageProps {
    if (!status) {
      if (sending || !failure) return { title: "Checking this Mac", tone: "working" };
      return problem(words(failure), {
        actions: (
          <button className="btn btn--primary" onClick={setup.begin} type="button">
            Try again
          </button>
        ),
      });
    }
    const step = status.stage === "done" ? undefined : rail.indexOf(status.stage);
    const needs =
      !again &&
      status.state !== "decide" &&
      (status.stage === "mac" || status.stage === "connect") ? (
        <IphoneSetupNeeds marks={needMarks(status)} />
      ) : null;
    const notice = failure ? <SendFailed words={words(failure)} /> : null;
    const usbOnly =
      status.stage === "wifi" ? (
        <button
          className="btn"
          disabled={busy}
          onClick={() =>
            setup.send("wifi", () => port.wifi({ setupId: status.setupId, choice: "usb-only" }))
          }
          type="button"
        >
          Only when plugged in
        </button>
      ) : null;

    switch (status.state) {
      case "working":
        return {
          ...working(status, { againName: again ? againName : null, deploymentName, phoneName }),
          after: needs,
          body: notice,
          step,
        };
      case "waiting": {
        const said = status.reason ? words(status.reason) : waitingFallback;
        return {
          ...(said.cue ? { cue: said.cue } : {}),
          actions: wrap(helpButton(status, help, busy), usbOnly),
          after: needs,
          body: wrap(notice, <HowTo words={said} />),
          detail: said.detail,
          icon: said.cue === "On this Mac" ? "laptop" : said.yours ? "phone" : "clock",
          step,
          title: said.title,
          tone: said.yours ? "you" : "working",
          waiting: said.waiting ?? "Waiting…",
        };
      }
      case "blocked": {
        const said = words(status.reason ?? "native-service-failed");
        return {
          ...problem(said, {
            actions: wrap(
              status.action === "retry" ? (
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() => setup.send("retry", () => port.retry({ setupId: status.setupId }))}
                  type="button"
                >
                  Try again
                </button>
              ) : status.action === "start-over" ? (
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={setup.startOver}
                  type="button"
                >
                  Start over
                </button>
              ) : (
                helpButton(status, help, busy)
              ),
              usbOnly,
            ),
            notice,
          }),
          step,
        };
      }
      case "decide":
        if (status.action === "choose-phone")
          return {
            body: (
              <div
                className="phone-setup__more iphone-setup__decision"
                ref={(element) => {
                  decision.current = element;
                }}
              >
                {notice}
                <CandidateList
                  busy={busy}
                  candidates={status.candidates}
                  deploymentName={deploymentName}
                  onChoose={(candidate) =>
                    setup.send("choose", () =>
                      port.choose({ setupId: status.setupId, candidateId: candidate.candidateId }),
                    )
                  }
                />
              </div>
            ),
            detail: status.candidates.every((candidate) => candidate.reason)
              ? "These iPhones need attention before they can be added."
              : "Choose the iPhone your agent will use.",
            step,
            title: status.candidates.every((candidate) => candidate.reason)
              ? "Check the connected iPhone"
              : again
                ? `Which iPhone is ${againName}?`
                : "Which iPhone?",
            tone: "you",
          };
        if (status.action === "choose-wifi")
          return {
            actions: (
              <div
                className="phone-setup__actions iphone-setup__decision"
                ref={(element) => {
                  decision.current = element;
                }}
              >
                <button
                  className="btn btn--primary"
                  disabled={busy}
                  onClick={() =>
                    setup.send("wifi", () => port.wifi({ setupId: status.setupId, choice: "wifi" }))
                  }
                  type="button"
                >
                  Use Wi‑Fi too
                </button>
                {usbOnly}
              </div>
            ),
            body: wrap(
              notice,
              <div className="phone-setup__more">
                <p>If macOS asks to let Opensteer find devices on your network, allow it.</p>
              </div>,
            ),
            detail: `Then ${again ? againName : phoneName} works whenever it’s on the same Wi‑Fi as this Mac, not only when it’s plugged in. Not on other networks or over cellular.`,
            icon: "wifi",
            step,
            title: "Also use it over Wi‑Fi?",
            tone: "you",
          };
        return {
          body: (
            <form
              className="phone-setup__more iphone-setup__name iphone-setup__decision"
              onSubmit={(event) => {
                event.preventDefault();
                const wanted = again ? "" : shownName.trim().slice(0, 120);
                setup.send("add", () =>
                  port.attach({ setupId: status.setupId, ...(wanted ? { name: wanted } : {}) }),
                );
              }}
              ref={(element) => {
                decision.current = element;
              }}
            >
              {notice}
              {again ? null : (
                <label className="field" htmlFor={nameId}>
                  <span className="field__label">Name</span>
                  <input
                    className="text-input"
                    id={nameId}
                    maxLength={120}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={status.suggestedName ?? "iPhone"}
                    type="text"
                    value={shownName}
                  />
                </label>
              )}
              <div className="phone-setup__actions">
                <button
                  className="btn btn--primary"
                  disabled={busy || (!again && !shownName.trim())}
                  type="submit"
                >
                  {again ? "Connect it again" : "Add iPhone"}
                </button>
              </div>
            </form>
          ),
          detail: again
            ? `This Mac can see its screen. ${againName} keeps its name, approvals and tab.`
            : "This Mac can see its screen. This is the name you and your agent will see.",
          icon: "eye",
          step,
          title: again ? `Connect ${againName} again` : "Name your iPhone",
          tone: "you",
        };
      case "done": {
        const shown = added?.name ?? (again ? againName : shownName || "Your iPhone");
        const reach = status.wifiEnabled
          ? "It works while it’s plugged into this Mac or on the same Wi‑Fi."
          : "It works while it’s plugged into this Mac.";
        return {
          actions:
            added && !again ? (
              <Link className="btn btn--primary" onClick={onClose} to={deviceRoute(added.id)}>
                Open the iPhone’s page
              </Link>
            ) : null,
          body:
            added && !again ? (
              <div className="phone-setup__more iphone-setup__done">
                <AgentAccessChoice client={client} machine={added} />
                <p className="iphone-setup__tip">
                  <Icon name="lightbulb" />
                  <span>{iphoneScreenKeepAwakeTip}</span>
                </p>
              </div>
            ) : null,
          detail: again ? `${reach} Your agent can use it as you allowed before.` : reach,
          title: again ? `${shown} is set up again` : `${shown} is added`,
          tone: "done",
        };
      }
    }
  }

  const done = status?.state === "done";
  return (
    <Dialog
      footer={
        <button className="btn" onClick={onClose} type="button">
          {done ? "Done" : "Cancel"}
        </button>
      }
      labelledBy="add-iphone-title"
      onClose={onClose}
      title={
        <span id="add-iphone-title">
          {!again
            ? "Add an iPhone"
            : reattaching
              ? `Set up ${againName} again`
              : `Fix setup for ${againName}`}
        </span>
      }
    >
      <SetupStage {...stage()} steps={rail.length} />
    </Dialog>
  );
}

/**
 * One setup on the Mac for as long as the dialog is open: begun on open,
 * followed through every status the Mac pushes, cancelled on close.
 */
function useIphoneSetup(
  port: IphoneSetupPort,
  deploymentId: DeploymentId,
  existing: ExistingIphoneTarget | undefined,
) {
  const [status, setStatus] = useState<Status | null>(null);
  const [sending, setSending] = useState<Sending | null>("begin");
  const [failure, setFailure] = useState<DesktopIphoneSetupReason | null>(null);
  const live = useRef<{ readonly setupId: string; readonly stop: () => void } | null>(null);
  // Bumped on close, so a reply that lands afterwards changes nothing.
  const epoch = useRef(0);
  const closed = useRef(false);
  function accept(next: Status) {
    setStatus((current) =>
      current?.setupId === next.setupId && current.revision >= next.revision ? current : next,
    );
  }

  function follow(next: Status) {
    if (live.current?.setupId === next.setupId) return;
    live.current?.stop();
    live.current = { setupId: next.setupId, stop: () => {} };
    const stop = port.subscribe({ setupId: next.setupId }, (pushed) => {
      if (live.current?.setupId !== pushed.setupId) return;
      accept(pushed);
    });
    live.current = { setupId: next.setupId, stop };
  }

  function send(what: Sending, call: () => Promise<Status>) {
    const mine = epoch.current;
    setSending(what);
    setFailure(null);
    void call()
      .then((next) => {
        if (epoch.current !== mine) {
          // Setup that began as the dialog closed is still the Mac's to cancel.
          if (closed.current) void port.cancel({ setupId: next.setupId }).catch(ignore);
          return;
        }
        follow(next);
        accept(next);
      })
      .catch((error: unknown) => {
        if (epoch.current === mine) setFailure(thrownReason(error));
      })
      .finally(() => {
        if (epoch.current === mine) setSending(null);
      });
  }

  function begin() {
    send("begin", () => port.begin({ deploymentId, ...(existing ? { target: existing } : {}) }));
  }

  function startOver() {
    const previous = live.current;
    live.current = null;
    previous?.stop();
    send("start-over", async () => {
      if (previous) await port.cancel({ setupId: previous.setupId }).catch(ignore);
      return port.begin({ deploymentId, ...(existing ? { target: existing } : {}) });
    });
  }

  useEffect(() => {
    closed.current = false;
    begin();
    return () => {
      closed.current = true;
      epoch.current += 1;
      const current = live.current;
      live.current = null;
      current?.stop();
      if (current) void port.cancel({ setupId: current.setupId }).catch(ignore);
    };
    // One setup per open dialog; the port and deployment are fixed while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { begin, failure, send, sending, startOver, status };
}

function needMarks(status: Status): NeedMarks {
  const onMac = status.stage === "mac";
  const xcodeWaits =
    status.reason === "xcode-missing" ||
    status.reason === "xcode-installing" ||
    status.reason === "xcode-setup-required" ||
    status.reason?.startsWith("developer-image-") === true;
  const phones = status.phone ? [status.phone] : status.candidates;
  const supported = phones.some(
    (phone) => !("reason" in phone && phone.reason === "unsupported-ios") && phone.osVersion,
  );
  return {
    xcode: !onMac
      ? "done"
      : status.state === "working"
        ? "checking"
        : xcodeWaits
          ? "you"
          : "checking",
    ios: supported
      ? "done"
      : phones.some((phone) => "reason" in phone && phone.reason === "unsupported-ios")
        ? "you"
        : "todo",
    cable: phones.length > 0 ? "done" : "todo",
    passcode: "info",
  };
}

function working(
  status: Status,
  names: {
    readonly againName: string | null;
    readonly deploymentName: string;
    readonly phoneName: string;
  },
): Pick<SetupStageProps, "detail" | "title" | "tone"> {
  switch (status.stage) {
    case "mac":
      return { title: "Checking this Mac", tone: "working" };
    case "connect":
      return {
        title: status.phone ? `Connecting to ${names.phoneName}` : "Looking for iPhones",
        tone: "working",
      };
    case "trust":
      return { title: `Pairing with ${names.phoneName}`, tone: "working" };
    case "developer-mode":
      return { title: "Checking Developer Mode", tone: "working" };
    case "prepare":
      return {
        detail:
          "Loading Apple’s developer tools onto it and taking a first look at its screen. The first time can take a minute.",
        title: `Getting ${names.phoneName} ready`,
        tone: "working",
      };
    case "wifi":
      return {
        detail: "If the iPhone asks, tap Trust and enter its passcode.",
        title: "Turning on Wi‑Fi access",
        tone: "working",
      };
    case "add":
    case "done":
      return {
        title: names.againName
          ? `Connecting ${names.againName} again`
          : `Adding it to ${names.deploymentName}`,
        tone: "working",
      };
  }
}

const waitingFallback: IphoneSetupWords = {
  detail: "Setup carries on by itself.",
  recovery: "check",
  title: "Waiting for the iPhone",
  yours: true,
};

function problem(
  said: IphoneSetupWords,
  parts: { readonly actions: ReactNode; readonly notice?: ReactNode },
): SetupStageProps {
  return {
    actions: parts.actions,
    body: wrap(parts.notice ?? null, <HowTo words={said} />),
    ...(said.cue ? { cue: said.cue } : {}),
    detail: said.detail,
    icon: "alert-circle",
    title: said.title,
    tone: "problem",
  };
}

function helpButton(
  status: Status,
  onHelp: (action: "get-xcode" | "open-xcode" | "open-local-network") => void,
  busy: boolean,
): ReactNode {
  const action = status.action;
  if (action !== "get-xcode" && action !== "open-xcode" && action !== "open-local-network")
    return null;
  return (
    <button
      className="btn btn--primary"
      disabled={busy}
      onClick={() => onHelp(action)}
      type="button"
    >
      {action === "get-xcode"
        ? "Get Xcode"
        : action === "open-xcode"
          ? "Open Xcode"
          : "Open Local Network settings"}
    </button>
  );
}

/** The exact moves for a reason, then its less likely fix behind a disclosure. */
function HowTo({ words }: { readonly words: IphoneSetupWords }) {
  if (!words.steps && !words.more) return null;
  return (
    <div className="phone-setup__more">
      {words.steps ? (
        <ol className="iphone-setup__steps">
          {words.steps.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      ) : null}
      {words.more ? (
        <details>
          <summary>{words.more.summary}</summary>
          {words.more.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </details>
      ) : null}
    </div>
  );
}

function SendFailed({ words }: { readonly words: IphoneSetupWords }) {
  return (
    <p className="notice notice--error iphone-setup__notice" role="alert">
      {words.title}. {words.detail}
    </p>
  );
}

/** Plugged-in iPhones to pick from, only when there's more than one. */
function CandidateList({
  busy,
  candidates,
  deploymentName,
  onChoose,
}: {
  readonly busy: boolean;
  readonly candidates: readonly Candidate[];
  readonly deploymentName: string;
  readonly onChoose: (candidate: Candidate) => void;
}) {
  return (
    <div className="iphone-setup__choices">
      {candidates.map((candidate) => {
        const unknown = candidate.trust === "untrusted";
        const checking = candidate.trust === "checking";
        const title = unknown
          ? "An iPhone that hasn’t trusted this Mac yet"
          : checking
            ? "iPhone"
            : candidate.name || "iPhone";
        const facts = checking
          ? "Checking this iPhone…"
          : unknown
            ? "Its name shows once you tap Trust on it."
            : [candidate.model, candidate.osVersion && `iOS ${candidate.osVersion}`]
                .filter(Boolean)
                .join(", ");
        const leading = (
          <span className="option-row__glyph option-row__glyph--outline">
            <Icon name="phone" />
          </span>
        );
        if (candidate.reason) {
          const said = iphoneSetupWords(candidate.reason, {
            deploymentName,
            osVersion: candidate.osVersion || null,
            stage: "connect",
          });
          return (
            <OptionRow
              as="static"
              detail={facts}
              framed
              key={candidate.candidateId}
              leading={leading}
              note={checking ? undefined : `${said.title}. ${said.detail}`}
              title={title}
            />
          );
        }
        return (
          <OptionRow
            as="button"
            detail={facts}
            disabled={busy}
            framed
            key={candidate.candidateId}
            leading={leading}
            onClick={() => onChoose(candidate)}
            title={title}
            trailing={<Icon name="chevron-right" />}
          />
        );
      })}
    </div>
  );
}

const accessChoices: readonly {
  readonly value: IphoneAgentAccess;
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    value: "read-write",
    title: "View and control",
    detail: "Your agent can see the screen, tap, swipe, press buttons and open apps.",
  },
  {
    value: "read",
    title: "View only",
    detail: "Your agent can see the screen but can’t touch it.",
  },
  {
    value: "none",
    title: "Not yet",
    detail: "Your agent can’t use it. You can allow it on its page any time.",
  },
];

/** The first approval, asked where setup ends; the Host's answer is what shows as chosen. */
function AgentAccessChoice({
  client,
  machine,
}: {
  readonly client: HostClient;
  readonly machine: MachineSummary;
}) {
  const revision = useHostSelector(client, (snapshot) => snapshot.machineRevision);
  const apps = useComputerAppData(client, revision);
  const [pending, setPending] = useState<IphoneAgentAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const name = useId();
  const view = apps.data ? phoneUseView({ ...apps.data, hostConnected: true, machine }) : null;
  const appsOn = machine.capabilities?.apps.enabled !== false;
  const current: IphoneAgentAccess = appsOn && view?.access ? view.access : "none";
  const shown = pending ?? current;

  async function choose(choice: IphoneAgentAccess) {
    if (choice === current || pending) return;
    setPending(choice);
    setError(null);
    try {
      await act(client, { label: "change this", done: "changed" }, () =>
        setIphoneAgentAccess(client, machine, view?.connectionId ?? null, choice),
      );
      await apps.reload();
    } catch (reason) {
      setError(failureWords(reason));
    } finally {
      setPending(null);
    }
  }

  return (
    <fieldset className="iphone-setup__access" disabled={!view}>
      <legend>What can your agent do with it?</legend>
      {accessChoices.map((choice) => (
        <OptionRow
          as="radio"
          checked={shown === choice.value}
          detail={choice.detail}
          disabled={!view || pending !== null}
          framed
          key={choice.value}
          name={name}
          onSelect={() => void choose(choice.value)}
          title={choice.title}
          value={choice.value}
        />
      ))}
      {error ? (
        <p className="notice notice--error" role="alert">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

/** Two parts in fixed places, or nothing when neither is there. */
function wrap(first: ReactNode, second: ReactNode): ReactNode {
  if (first == null && second == null) return null;
  return (
    <>
      {first}
      {second}
    </>
  );
}

/** Electron's invoke keeps only an error's message, which the Mac's setup sets to its reason. */
function thrownReason(error: unknown): DesktopIphoneSetupReason {
  const message = error instanceof Error ? error.message : "";
  const parsed = DesktopIphoneSetupReasonSchema.safeParse(message.split(/[:\s]+/u).pop());
  return parsed.success ? parsed.data : "native-service-failed";
}
