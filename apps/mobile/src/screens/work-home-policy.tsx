import { workHomeSeeView, workHomeMark } from "@opensteer/client/host";
import { useWorkPolicy } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, type ReactNode } from "react";
import { DeploymentGate, useAttachedHost } from "./deployment-gate.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import { workHomePolicySections } from "./work-home-policy-sections.js";

type Props = StaticScreenProps<{ readonly deploymentId: string }>;

/** "What {organization} can see", read from the work Home itself. */
export function WorkHomePolicyScreen({ route }: Props): ReactNode {
  const host = useAttachedHost(route.params.deploymentId);
  return host ? (
    <WorkHomePolicy host={host} />
  ) : (
    <DeploymentGate deploymentId={route.params.deploymentId} />
  );
}

function WorkHomePolicy(props: {
  readonly host: NonNullable<ReturnType<typeof useAttachedHost>>;
}): ReactNode {
  const navigation = useNavigation();
  const policy = useWorkPolicy(props.host);
  const title = workHomeMark(policy)?.seeTitle ?? null;
  useEffect(() => {
    if (title) navigation.setOptions({ title });
    // A personal Home has no such page: nothing to show, so go back.
    if (policy === null && navigation.canGoBack()) navigation.goBack();
  }, [navigation, policy, title]);
  return (
    <NativeSettingsPage
      sections={
        policy
          ? workHomePolicySections(workHomeSeeView(policy))
          : [
              {
                key: "loading",
                title: "",
                rows: [{ key: "loading", kind: "placeholder", label: "Loading…" }],
              },
            ]
      }
    />
  );
}
