import { useId, useState } from "react";
import type { OpensteerDesktopBridge } from "@opensteer/protocol/desktop";
import { deviceAccess } from "@opensteer/protocol";
import { hostsDeployment, withDeviceSwitch } from "@opensteer/client/computers";
import { mutationIdempotencyKey } from "@opensteer/client/host";
import { actionErrorMessage } from "../../ui-utils.js";
import { useShell } from "../app-shell.js";
import { SetupFooter, SetupFrame } from "../first-run/setup-frame.js";
import { SetupList } from "../first-run/setup-list.js";
import { ErrorNotice } from "../onboarding-card.js";
import { capabilityDetailHere } from "./device-access.js";
import { deviceNotificationsOn, setDeviceNotifications } from "./device-preferences.js";
import { MacosPermissionRows, useMacosGrants } from "./macos-permission-rows.js";
import { SetupGroup, SwitchRow } from "./set-up-this-mac.js";

export function HomeSetupStep({
  bridge,
  onBack,
  onNext,
  progress,
}: {
  readonly bridge: OpensteerDesktopBridge;
  readonly onBack?: (() => void) | undefined;
  readonly onNext: () => void;
  readonly progress: { readonly count: number; readonly index: number };
}) {
  const { hostClient, snapshot } = useShell();
  const home = snapshot.machines.find(hostsDeployment) ?? null;
  const deploymentId = snapshot.deploymentId;
  const [phase, setPhase] = useState<"choose" | "macos">("choose");
  const [name, setName] = useState(home?.name ?? "");
  const [apps, setApps] = useState(home?.access ? deviceAccess(home.access.policy).apps : true);
  const [notifications, setNotifications] = useState(
    deploymentId ? deviceNotificationsOn(deploymentId) : true,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { grants, reload } = useMacosGrants(bridge);
  const nameId = useId();
  const switchable = snapshot.devicesAvailable === true;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const next = name.trim();
      if (home && next && next !== home.name) {
        const result = await hostClient.dispatch({
          idempotencyKey: mutationIdempotencyKey("device-rename"),
          machineId: home.id,
          name: next,
          type: "machine.rename",
        });
        if (result.type !== "machine.rename") throw new Error("The rename didn’t finish.");
      }
      if (switchable && home?.access && deviceAccess(home.access.policy).apps !== apps) {
        const result = await hostClient.updateMachineAccess({
          expectedRevision: home.access.revision,
          policy: withDeviceSwitch(home.access.policy, "apps", apps),
          runnerId: home.id,
        });
        if (result.outcome === "conflict") {
          await hostClient.refresh();
          throw new Error("Apps changed on another device. Check it and continue.");
        }
      }
      if (deploymentId) setDeviceNotifications(deploymentId, notifications);
      if (notifications) void bridge.testNotification().catch(() => undefined);
      if (apps || !switchable) setPhase("macos");
      else onNext();
    } catch (reason) {
      setError(actionErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  if (phase === "macos")
    return (
      <SetupFrame
        description="Apps need macOS’s permission. Each one turns green as soon as you allow it."
        footer={
          <SetupFooter
            action={
              <button className="btn btn--primary" onClick={onNext} type="button">
                Continue
              </button>
            }
            onBack={() => setPhase("choose")}
            onSkip={onNext}
            skipLabel="Do this later"
          />
        }
        progress={progress}
        stepKey="home-macos"
        title="Let macOS allow it"
      >
        <SetupList label="macOS permissions">
          <MacosPermissionRows
            apps
            bridge={bridge}
            files={false}
            grants={grants}
            onAsked={reload}
          />
        </SetupList>
      </SetupFrame>
    );

  return (
    <SetupFrame
      description="Your Opensteer runs here, so your agent always has this Mac’s browser and files."
      footer={
        <SetupFooter
          action={
            <button
              className="btn btn--primary"
              disabled={saving}
              onClick={() => void save()}
              type="button"
            >
              {saving ? "Saving…" : "Continue"}
            </button>
          }
          onBack={onBack}
        />
      }
      progress={progress}
      stepKey="home-choose"
      title="Set up this Mac"
    >
      {home ? (
        <label className="field" htmlFor={nameId}>
          <span className="field__label">Name</span>
          <input
            className="text-input"
            disabled={saving}
            id={nameId}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </label>
      ) : null}
      {switchable ? (
        <SetupGroup title="Your agent can use">
          <SwitchRow
            checked={apps}
            detail={capabilityDetailHere.apps}
            disabled={saving}
            label="Apps"
            onChange={setApps}
          />
        </SetupGroup>
      ) : null}
      <SetupGroup title="On this Mac">
        <SwitchRow
          checked={notifications}
          detail="Tell you when your agent needs you or finishes"
          disabled={saving}
          label="Notifications"
          onChange={setNotifications}
        />
      </SetupGroup>
      <ErrorNotice message={error} />
      <p className="setup-frame__note">Change any of these later in Devices.</p>
    </SetupFrame>
  );
}
