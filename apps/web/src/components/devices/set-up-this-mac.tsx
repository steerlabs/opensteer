import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { Icon } from "../icon.js";
import { SetupFooter, SetupFrame } from "../first-run/setup-frame.js";
import { SetupList, SetupRow } from "../first-run/setup-list.js";
import { ErrorNotice } from "../onboarding-card.js";
import { capabilityDetailHere, capabilityLabel, type DeviceCapability } from "./device-access.js";
import { MacosPermissionRows, missingMacosGrant, useMacosGrants } from "./macos-permission-rows.js";
import { deviceRoute } from "./device-routes.js";
import { finishSetupLine } from "./device-setup.js";
import type { DeviceSetupChoice, ThisDevice } from "./this-device.js";

const notificationsDetail = "Tell you when your agent needs you or finishes";

/** One switch row: the capability, what it means here, and its own labelled switch. */
export function SwitchRow({
  checked,
  detail,
  disabled = false,
  label,
  onChange,
}: {
  readonly checked: boolean;
  readonly detail: ReactNode;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <SetupRow
      detail={<span id={`${id}-detail`}>{detail}</span>}
      title={<label htmlFor={id}>{label}</label>}
      trailing={
        <input
          aria-describedby={`${id}-detail`}
          checked={checked}
          className="switch"
          disabled={disabled}
          id={id}
          onChange={(event) => onChange(event.currentTarget.checked)}
          role="switch"
          type="checkbox"
        />
      }
    />
  );
}

/** A captioned group of setup rows, so "Your agent can use" reads apart from this Mac's own. */
export function SetupGroup({
  children,
  title,
}: {
  readonly children: ReactNode;
  readonly title: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="device-setup__group">
      <h2 className="device-setup__caption" id={id}>
        {title}
      </h2>
      <SetupList label={title}>{children}</SetupList>
    </section>
  );
}

/**
 * The full window a Mac shows until it is one of this person's devices: its
 * name and switches, then the macOS grants they need, then an honest Ready.
 */
export function SetUpThisMac({
  bridge,
  device,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly device: ThisDevice;
}) {
  if (device.step === "macos") return <MacosStep bridge={bridge} device={device} />;
  if (device.step === "ready") return <ReadyStep bridge={bridge} device={device} />;
  return <ChooseStep device={device} />;
}

function ChooseStep({ device }: { readonly device: ThisDevice }) {
  const [name, setName] = useState(device.choice?.name ?? device.computerName);
  const [access, setAccess] = useState(
    device.choice?.access ?? { browser: true, apps: true, files: true },
  );
  const [notifications, setNotifications] = useState(device.choice?.notifications ?? true);
  const nameId = useId();
  const working = device.stage !== null;
  const trimmed = name.trim();
  const failure =
    device.cause && device.cause.kind !== "use-from-anywhere" && device.cause.detail
      ? device.cause.detail
      : null;
  const submit = (choice: DeviceSetupChoice) => void device.setUp(choice);
  return (
    <SetupFrame
      description={`It joins ${device.opensteerName} as one of your devices. Your agent keeps running on ${device.homeName} and can reach this Mac for what you leave on.`}
      footer={
        <SetupFooter
          action={
            <button
              className="btn btn--primary"
              disabled={working || trimmed.length === 0}
              onClick={() => submit({ name: trimmed, access, notifications })}
              type="button"
            >
              {working ? "Setting up…" : "Continue"}
            </button>
          }
        />
      }
      progress={{ count: 2, index: 0 }}
      stepKey="device-choose"
      title="Set up this Mac"
    >
      <label className="field" htmlFor={nameId}>
        <span className="field__label">Name</span>
        <input
          autoComplete="off"
          className="text-input"
          disabled={working}
          id={nameId}
          maxLength={120}
          onChange={(event) => setName(event.target.value)}
          value={name}
        />
      </label>
      <SetupGroup title="Your agent can use">
        {(["browser", "apps", "files"] as const).map((capability) => (
          <SwitchRow
            checked={access[capability]}
            detail={capabilityDetailHere[capability]}
            disabled={working}
            key={capability}
            label={capabilityLabel[capability]}
            onChange={(on) => setAccess((current) => ({ ...current, [capability]: on }))}
          />
        ))}
      </SetupGroup>
      <SetupGroup title="On this Mac">
        <SwitchRow
          checked={notifications}
          detail={notificationsDetail}
          disabled={working}
          label="Notifications"
          onChange={setNotifications}
        />
      </SetupGroup>
      <ErrorNotice message={failure} />
      <p className="setup-frame__note">Change any of these later in Devices.</p>
    </SetupFrame>
  );
}

function MacosStep({
  bridge,
  device,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly device: ThisDevice;
}) {
  const { grants, reload } = useMacosGrants(bridge);
  const access = device.choice?.access ?? switchesOf(device);
  const finish = () => device.goTo("ready");
  return (
    <SetupFrame
      description="Apps and Files and commands need macOS’s permission. Each one turns green as soon as you allow it."
      footer={
        <SetupFooter
          action={
            <button className="btn btn--primary" onClick={finish} type="button">
              Finish
            </button>
          }
          onSkip={finish}
          skipLabel="Do this later"
        />
      }
      progress={{ count: 2, index: 1 }}
      stepKey="device-macos"
      title="Let macOS allow it"
    >
      <SetupList label="macOS permissions">
        <MacosPermissionRows
          apps={access.apps}
          bridge={bridge}
          files={access.files}
          grants={grants}
          onAsked={reload}
        />
      </SetupList>
      <p className="setup-frame__note">
        Later is fine. The device page shows what’s still waiting, and your agent asks you here if
        it needs it first.
      </p>
    </SetupFrame>
  );
}

function ReadyStep({
  bridge,
  device,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly device: ThisDevice;
}) {
  const { grants } = useMacosGrants(bridge);
  const access = device.choice?.access ?? switchesOf(device);
  const name = device.machine?.name ?? device.choice?.name ?? device.computerName;
  const anything = access.browser || access.apps || access.files;
  const rows: readonly {
    readonly label: string;
    readonly state: string;
    readonly waiting: boolean;
  }[] = [
    ...(["browser", "apps", "files"] as const).map((capability: DeviceCapability) => {
      const on = access[capability];
      const waiting = on && missingMacosGrant(grants, capability);
      return {
        label: capabilityLabel[capability],
        state: waiting ? "On · needs macOS permission" : on ? "On" : "Off",
        waiting,
      };
    }),
    {
      label: "Notifications",
      state: device.choice?.notifications === false ? "Off" : "On",
      waiting: false,
    },
  ];
  return (
    <SetupFrame
      description={
        anything
          ? `It’s one of your devices now. Tabs you open here run here, and your agent can reach it from ${device.homeName}.`
          : "Your agent can’t use it until you turn something on."
      }
      footer={
        <SetupFooter
          action={
            <Link className="btn btn--primary" onClick={() => device.goTo(null)} to="/">
              Start using Opensteer
            </Link>
          }
        />
      }
      progress={{ count: 2, index: 1 }}
      stepKey="device-ready"
      title={anything ? `${name} is ready` : `${name} is signed in`}
    >
      <ul aria-label={`On ${name}`} className="setup-list device-setup__summary">
        {rows.map((row) => (
          <li className="setup-row" key={row.label}>
            <div className="setup-row__main">
              <span className="setup-row__text">
                <span className="setup-row__title">{row.label}</span>
              </span>
              <span
                className={`device-setup__state${row.waiting ? " device-setup__state--waiting" : row.state === "Off" ? " device-setup__state--off" : ""}`}
              >
                {row.state}
              </span>
            </div>
          </li>
        ))}
      </ul>
      {device.machineId ? (
        <Link
          className="link-btn device-setup__review"
          onClick={() => device.goTo(null)}
          to={deviceRoute(device.machineId)}
        >
          Review this Mac
          <Icon name="chevron-right" />
        </Link>
      ) : null}
    </SetupFrame>
  );
}

function switchesOf(device: ThisDevice): DeviceSetupChoice["access"] {
  const policy = device.machine?.access?.policy;
  return {
    browser: policy?.browser ?? true,
    apps: policy?.apps ?? true,
    files: policy ? policy.reach !== "nobody" : true,
  };
}

/**
 * Setup that couldn't finish never blocks work: the workspace opens under this
 * bar, whose button fixes what actually stands in the way.
 */
export function FinishSetupBar({
  device,
  homeId,
  onNavigate,
}: {
  readonly device: ThisDevice;
  readonly homeId: string | null;
  readonly onNavigate: (path: string) => void;
}) {
  const [pending, setPending] = useState(false);
  if (!device.cause || device.step !== null) return null;
  const cause = device.cause;
  const line = finishSetupLine(cause);
  const act = () => {
    if (cause.kind === "use-from-anywhere") {
      onNavigate(homeId ? `${deviceRoute(homeId)}#use-from-anywhere` : "/settings/account");
      return;
    }
    if (cause.kind === "bind") {
      setPending(true);
      void device.retryBind().finally(() => setPending(false));
      return;
    }
    device.openSetup();
  };
  return (
    <div className="device-finish-bar" role="status">
      <Icon name="alert-circle" />
      <span className="device-finish-bar__text">{line.text}</span>
      <span className="device-finish-bar__actions">
        {cause.kind === "use-from-anywhere" ? (
          <button className="link-btn" onClick={device.openSetup} type="button">
            Try again
          </button>
        ) : null}
        <button
          className="btn btn--small btn--primary"
          disabled={pending}
          onClick={act}
          type="button"
        >
          {pending ? "Trying…" : line.action}
        </button>
      </span>
    </div>
  );
}
