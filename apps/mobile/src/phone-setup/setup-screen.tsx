import { hostsDeployment, isServiceMachine } from "@opensteer/client/computers";
import type { HostClient } from "@opensteer/client/host";
import {
  StackActions,
  useNavigation,
  usePreventRemove,
  type StaticScreenProps,
} from "@react-navigation/native";
import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Linking, Platform } from "react-native";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { useIphoneApps } from "../iphone-apps/context.js";
import { opensteerOn } from "../iphone-apps/model.js";
import { aiCompanies, aiCompanyNames, genericAiCompany } from "@opensteer/client/ai-sharing";
import { DeploymentGate, useAttachedHost } from "../screens/deployment-gate.js";
import { useHostValue, useMobileState } from "../ui/mobile-client-context.js";
import { useMobileNotifications } from "../ui/notifications-context.js";
import {
  PhoneSetup,
  phoneSetupDraft,
  phoneSetupSharesAnything,
  type PhoneSetupDraft,
  type PhoneSetupState,
} from "./phone-setup.js";
import { ReadyForm, SetupForm } from "./setup-form.js";
import { dismissPhoneSetup } from "./use-phone-setup.js";
import {
  readyBody,
  readyRows,
  readyTitle,
  setupDisclosure,
  setupFailureText,
  setupSwitches,
} from "./setup-view.js";

type SetupProps = StaticScreenProps<{ readonly deploymentId: string }>;

/** Set up this phone: a full-screen step pushed over Home after sign-in, with no Back. */
export function SetUpPhoneScreen({ route }: SetupProps): ReactNode {
  const hostClient = useAttachedHost(route.params.deploymentId);
  return hostClient === null ? (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  ) : (
    <SetUpPhone deploymentId={route.params.deploymentId} hostClient={hostClient} />
  );
}

function SetUpPhone(props: { readonly deploymentId: string; readonly hostClient: HostClient }) {
  const navigation = useNavigation();
  const controller = useIphoneApps();
  const { registration } = useMobileNotifications();
  const { rows } = useMobileState();
  const platform = Platform.OS === "android" ? "android" : "ios";
  const [draft, setDraft] = useState<PhoneSetupDraft>(() => phoneSetupDraft(controller, platform));
  const setup = useRef<PhoneSetup | null>(null);
  setup.current ??= new PhoneSetup(draft);
  const state = useSyncExternalStore(
    setup.current.subscribe,
    setup.current.getState,
    setup.current.getState,
  );
  const devicesAvailable = useHostValue(
    props.hostClient,
    (snapshot) => snapshot.devicesAvailable === true,
    false,
  );
  const companies = useHostValue(
    props.hostClient,
    (snapshot) => aiCompanyNames(aiCompanies(snapshot)),
    genericAiCompany,
  );
  const busy = state.phase.kind === "enrolling" || state.phase.kind === "asking";
  const failed = state.phase.kind === "failed";
  // Setup leaves only forward, or by Not now once it has failed.
  usePreventRemove(!failed && state.phase.kind !== "ready", () => undefined);
  const switches = setupSwitches({ busy, devicesAvailable, draft, noun: thisPhoneNoun, state });
  const opensteer = opensteerOn(
    rows.find((row) => row.deploymentId === props.deploymentId)?.name ?? "Opensteer",
  );

  const run = (): void => {
    if (busy || draft.name.trim() === "") return;
    void setup
      .current!.run({
        controller,
        deploymentId: props.deploymentId,
        draft,
        hostClient: props.hostClient,
        notifications: {
          request: async () => {
            await registration.requestPermission();
            return registration.getSnapshot().status !== "permission-denied";
          },
        },
      })
      .then((settled) => {
        if (settled.phase.kind !== "ready") return;
        navigation.dispatch(
          StackActions.replace("PhoneReady", {
            deploymentId: props.deploymentId,
            name: draft.name.trim(),
            outcome: settled,
          }),
        );
      });
  };

  return (
    <SetupForm
      agent={switches.agent}
      busy={busy}
      continueLabel={failed ? "Try again" : "Continue"}
      disclosure={setupDisclosure(opensteer, companies, thisPhoneNoun)}
      failure={setupFailureText(state, opensteer, thisPhoneNoun)}
      name={draft.name}
      notifications={switches.notifications}
      noun={thisPhoneNoun}
      onContinue={run}
      onName={(name) => setDraft((current) => ({ ...current, name }))}
      onNotNow={
        failed
          ? () => {
              dismissPhoneSetup(props.deploymentId);
              navigation.goBack();
            }
          : null
      }
      onOpenSettings={() => void Linking.openSettings()}
      onToggle={(key, value) =>
        setDraft((current) =>
          key === "browser"
            ? { ...current, browser: value }
            : key === "notifications"
              ? { ...current, notifications: value }
              : { ...current, apps: { ...current.apps, [key]: value } },
        )
      }
      photos={switches.photos}
      title={`Set up this ${thisPhoneNoun}`}
    />
  );
}

type ReadyProps = StaticScreenProps<{
  readonly deploymentId: string;
  readonly name: string;
  readonly outcome: PhoneSetupState;
}>;

/** Ready, reached only forward from setup; Start using Opensteer returns to Home. */
export function PhoneReadyScreen({ route }: ReadyProps): ReactNode {
  const navigation = useNavigation();
  const hostClient = useAttachedHost(route.params.deploymentId);
  const homeName = useHostValue(
    hostClient,
    (snapshot) =>
      snapshot.machines.find(
        (machine) =>
          !isServiceMachine(machine) && (machine.kind === "home" || hostsDeployment(machine)),
      )?.name ?? null,
    null,
  );
  const devicesAvailable = useHostValue(
    hostClient,
    (snapshot) => snapshot.devicesAvailable === true,
    false,
  );
  const { outcome, name } = route.params;
  const rows = useMemo(() => readyRows(outcome, devicesAvailable), [devicesAvailable, outcome]);
  return (
    <ReadyForm
      agent={rows.agent}
      body={readyBody({ homeName, name, sharesAnything: phoneSetupSharesAnything(outcome) })}
      here={rows.here}
      noun={thisPhoneNoun}
      onDone={() => navigation.goBack()}
      title={readyTitle(name)}
    />
  );
}
