import type { ComputerUseDataGrant } from "@opensteer/protocol";
import type {
  DesktopComputerAppSetup,
  DesktopComputerAppSetupStatus,
  DesktopComputerAppSetupStep,
  DesktopComputerAppSetupTarget,
} from "@opensteer/protocol/desktop";
import { computerUseHelperName } from "@opensteer/client/integrations";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../components/icon.js";

const pollIntervalMs = 1_000;
const doneLingerMs = 1_400;
const shakeMs = 600;

/**
 * Everything the panel needs; it never talks to a Host. Set up and closing
 * name the app drawn, so one that arrives after the next app replaced it is
 * ignored.
 */
export interface ComputerAppSetupPanelBridge {
  readonly closeComputerAppSetup: (input: DesktopComputerAppSetupTarget) => Promise<unknown>;
  readonly computerAppSetupBegin: (input: DesktopComputerAppSetupTarget) => Promise<unknown>;
  readonly computerAppSetupShowAgain: () => Promise<unknown>;
  readonly computerAppSetupStartDrag: () => Promise<unknown>;
  readonly computerAppSetupStatus: () => Promise<DesktopComputerAppSetupStatus>;
}

/** What each grant lets agents do, drawn rather than said. */
const capability: Readonly<Record<ComputerUseDataGrant, "eye" | "paper-plane">> = {
  automation: "paper-plane",
  calendars: "eye",
  contacts: "eye",
  "full-disk-access": "eye",
  reminders: "eye",
};

/**
 * The panel the desktop floats beside System Settings while one app the
 * helper serves is set up on this Mac.
 *
 * It explains with pictures: the row to switch on, looking as it does in the
 * macOS list, with its switch moving; an arrow toward System Settings; this
 * app's own row struck out, because its Full Disk Access is not the one; and
 * macOS's question with the pointer on Allow. Words are names and buttons;
 * anything longer is a tooltip. Main decides every step; the page draws the
 * one it is told and polls for the next.
 */
export function ComputerAppSetupPanel({
  bridge,
}: {
  readonly bridge: ComputerAppSetupPanelBridge;
}) {
  const [setup, setSetup] = useState<DesktopComputerAppSetup | null>(null);
  const [shaking, setShaking] = useState(false);
  const wrongBefore = useRef<boolean | null>(null);

  useEffect(() => {
    document.documentElement.dataset.panel = "computer-app-setup";
    return () => {
      delete document.documentElement.dataset.panel;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let reading = false;
    const read = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = await bridge.computerAppSetupStatus();
        if (active) setSetup(next.setup);
      } catch {
        // A read that fails answers nothing; the last picture stays up and the
        // next read, a second later, tries again.
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = globalThis.setInterval(() => void read(), pollIntervalMs);
    return () => {
      active = false;
      globalThis.clearInterval(timer);
    };
  }, [bridge]);

  // This app switched on instead of the helper: the panel shakes once, and the
  // struck-out row shows which one it was.
  const current = setup?.steps.find(({ state }) => state === "current") ?? null;
  const onFullDiskAccess =
    setup?.phase === "steps" &&
    current?.grant === "full-disk-access" &&
    current.kind === "settings";
  const wrongNow = setup?.thisAppHasFullDiskAccess ?? false;
  useEffect(() => {
    const before = wrongBefore.current;
    wrongBefore.current = wrongNow;
    if (!onFullDiskAccess || before !== false || !wrongNow) return;
    setShaking(true);
    const timer = globalThis.setTimeout(() => setShaking(false), shakeMs);
    return () => globalThis.clearTimeout(timer);
  }, [onFullDiskAccess, wrongNow]);

  const doneId = setup?.phase === "done" ? setup.definitionId : null;
  useEffect(() => {
    if (!doneId) return;
    const timer = globalThis.setTimeout(() => {
      void bridge.closeComputerAppSetup({ definitionId: doneId }).catch(() => undefined);
    }, doneLingerMs);
    return () => globalThis.clearTimeout(timer);
  }, [bridge, doneId]);

  if (!setup) return <div className="cas-panel cas-panel--empty" />;
  const { definitionId } = setup;
  const close = () => void bridge.closeComputerAppSetup({ definitionId }).catch(() => undefined);

  return (
    <div className="cas-stage">
      <div
        aria-label={`Set up ${setup.targetName}`}
        className={`cas-panel${shaking ? " cas-panel--shake" : ""}${
          setup.helperReachable ? "" : " cas-panel--away"
        }`}
        role="dialog"
      >
        {setup.phase === "offer" ? (
          <Offer bridge={bridge} onClose={close} setup={setup} />
        ) : setup.phase === "done" ? (
          <Done onClose={close} setup={setup} />
        ) : (
          <Steps bridge={bridge} current={current} onClose={close} setup={setup} />
        )}
      </div>
    </div>
  );
}

function Offer({
  bridge,
  onClose,
  setup,
}: {
  readonly bridge: ComputerAppSetupPanelBridge;
  readonly onClose: () => void;
  readonly setup: DesktopComputerAppSetup;
}) {
  return (
    <>
      <div className="cas-offer">
        <Pair setup={setup} still />
        <span className="cas-title">Allow {setup.targetName}</span>
        <CloseButton label="Not now" onClose={onClose} />
      </div>
      <div className="cas-offer__foot">
        <Capabilities steps={setup.steps} />
        <button
          className="btn btn--primary btn--small cas-no-drag"
          onClick={() =>
            void bridge
              .computerAppSetupBegin({ definitionId: setup.definitionId })
              .catch(() => undefined)
          }
          title={`Only ${computerUseHelperName}, a small Opensteer app, gets this access.`}
          type="button"
        >
          Set up
        </button>
      </div>
    </>
  );
}

function Steps({
  bridge,
  current,
  onClose,
  setup,
}: {
  readonly bridge: ComputerAppSetupPanelBridge;
  readonly current: DesktopComputerAppSetupStep | null;
  readonly onClose: () => void;
  readonly setup: DesktopComputerAppSetup;
}) {
  const showAgain = () => void bridge.computerAppSetupShowAgain().catch(() => undefined);
  return (
    <>
      <div className="cas-top">
        <Dots steps={setup.steps} />
        {setup.helperReachable ? null : (
          <span className="cas-away" title={`Waiting for ${computerUseHelperName}`}>
            <span className="cas-spin" />
          </span>
        )}
        {current?.kind === "ask" ? (
          <button
            aria-label="Ask again"
            className="cas-icon-button cas-no-drag"
            onClick={showAgain}
            title="Ask again"
            type="button"
          >
            <Icon name="reload" />
          </button>
        ) : null}
        <CloseButton label="Not now" onClose={onClose} />
      </div>
      {current?.kind === "ask" ? (
        <AskPicture setup={setup} />
      ) : current ? (
        <SettingsPicture bridge={bridge} onShowAgain={showAgain} setup={setup} step={current} />
      ) : null}
    </>
  );
}

/**
 * The helper's row as the macOS list draws it, its switch turning on, and an
 * arrow toward System Settings, which reopens the pane. For Full Disk Access
 * the row drags into the list too, for a Mac that has not listed the helper.
 */
function SettingsPicture({
  bridge,
  onShowAgain,
  setup,
  step,
}: {
  readonly bridge: ComputerAppSetupPanelBridge;
  readonly onShowAgain: () => void;
  readonly setup: DesktopComputerAppSetup;
  readonly step: DesktopComputerAppSetupStep;
}) {
  const draggable = step.grant === "full-disk-access";
  return (
    <>
      <div className="cas-target">
        <div
          className={`cas-row cas-no-drag${draggable ? " cas-row--drag" : ""}`}
          draggable={draggable}
          onDragStart={(event) => {
            // The page cannot drag a file; main drags the installed helper.
            event.preventDefault();
            void bridge.computerAppSetupStartDrag().catch(() => undefined);
          }}
          title={
            draggable
              ? "Switch this on in System Settings, or drag it into the list"
              : "Switch this on in System Settings"
          }
        >
          <img alt="" className="cas-app-icon" draggable={false} src="/computer-use.png" />
          <span className="cas-row__name">{computerUseHelperName}</span>
          <span aria-hidden className="cas-switch cas-switch--turning-on" />
        </div>
        <button
          aria-label="Show in System Settings"
          className="cas-arrow cas-no-drag"
          onClick={onShowAgain}
          title="Show in System Settings"
          type="button"
        >
          <Icon name="arrow-right" />
        </button>
      </div>
      {setup.thisAppHasFullDiskAccess && step.grant === "full-disk-access" ? (
        <div
          className="cas-row cas-row--wrong"
          title={`${setup.appName} doesn't give ${setup.targetName} access`}
        >
          <img
            alt=""
            className="cas-app-icon cas-app-icon--small"
            draggable={false}
            src="/opensteer.png"
          />
          <span className="cas-row__name">{setup.appName}</span>
          <span aria-hidden className="cas-wrong-mark">
            <Icon name="close" />
          </span>
        </div>
      ) : null}
    </>
  );
}

/** macOS's question, drawn, with the pointer on Allow. */
function AskPicture({ setup }: { readonly setup: DesktopComputerAppSetup }) {
  return (
    <>
      <div className="cas-pair-center">
        <Pair setup={setup} />
      </div>
      <div className="cas-question" title="Choose Allow in the macOS question">
        <span className="cas-question__button">Don’t Allow</span>
        <span className="cas-question__button cas-question__button--allow">Allow</span>
        <span aria-hidden className="cas-pointer">
          <Icon name="cursor" />
        </span>
      </div>
    </>
  );
}

function Done({
  onClose,
  setup,
}: {
  readonly onClose: () => void;
  readonly setup: DesktopComputerAppSetup;
}) {
  return (
    <>
      <div className="cas-top">
        <Dots steps={setup.steps} />
      </div>
      <div className="cas-done">
        <Pair done setup={setup} />
        <Capabilities steps={setup.steps} />
      </div>
      <button
        className="btn btn--primary btn--small cas-wide cas-no-drag"
        onClick={onClose}
        type="button"
      >
        <Icon name="check" />
        Done
      </button>
    </>
  );
}

/** The helper reaching the app it serves: a link flowing while setup runs. */
function Pair({
  done = false,
  setup,
  still = false,
}: {
  readonly done?: boolean;
  readonly setup: DesktopComputerAppSetup;
  readonly still?: boolean;
}) {
  return (
    <span className="cas-pair" title={`${computerUseHelperName} reaches ${setup.targetName}`}>
      <span className="cas-badged">
        <img alt="" className="cas-app-icon" draggable={false} src="/computer-use.png" />
        {done ? (
          <span aria-hidden className="cas-check">
            <Icon name="check" />
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className={`cas-link${done ? " cas-link--done" : still ? " cas-link--still" : ""}`}
      />
      {setup.appIconPng ? (
        <img
          alt=""
          className="cas-app-icon"
          draggable={false}
          src={`data:image/png;base64,${setup.appIconPng}`}
        />
      ) : (
        <span aria-hidden className="cas-app-icon cas-app-icon--blank" />
      )}
    </span>
  );
}

/** One mark per step: read or send, with a check once macOS gives it. */
function Capabilities({ steps }: { readonly steps: readonly DesktopComputerAppSetupStep[] }) {
  const shown = [...new Set(steps.map(({ grant }) => capability[grant]))];
  return (
    <span className="cas-caps">
      {shown.map((kind) => {
        const done = steps
          .filter(({ grant }) => capability[grant] === kind)
          .every(({ state }) => state === "done");
        return (
          <span className="cas-cap" key={kind} title={kind === "eye" ? "Read" : "Send"}>
            <Icon name={kind} />
            <span aria-hidden className={`cas-cap__mark${done ? " cas-cap__mark--done" : ""}`}>
              {done ? <Icon name="check" /> : null}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function Dots({ steps }: { readonly steps: readonly DesktopComputerAppSetupStep[] }) {
  if (steps.length < 2) return <span className="cas-dots" />;
  const at = steps.findIndex(({ state }) => state !== "done");
  return (
    <span className="cas-dots" title={at === -1 ? "Done" : `Step ${at + 1} of ${steps.length}`}>
      {steps.map((step) => (
        <i className={`cas-dot cas-dot--${step.state}`} key={step.grant} />
      ))}
    </span>
  );
}

function CloseButton({ label, onClose }: { readonly label: string; readonly onClose: () => void }) {
  return (
    <button
      aria-label={label}
      className="cas-icon-button cas-no-drag"
      onClick={onClose}
      title={label}
      type="button"
    >
      <Icon name="close" />
    </button>
  );
}
