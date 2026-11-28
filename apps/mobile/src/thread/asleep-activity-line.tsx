import { asleepToolFailure } from "@opensteer/client/computers";
import type { ToolEntry } from "@opensteer/client/host";
import { useNavigation } from "@react-navigation/native";
import { useContext, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { AsleepMoment } from "../computers/cloud-suggestion.js";
import { useHostSelector } from "@opensteer/client/react";
import type { HostClient } from "@opensteer/client/host";
import {
  selectHomeDeploymentId,
  selectHomeExposure,
  selectHomeKind,
  usePhoneHome,
} from "../computers/home-kind.js";
import { space } from "../theme.js";
import { TranscriptComputersContext } from "./computer-use-line.js";

type Entry = { readonly kind: string };

/** The first call among these steps the Home refused because its Device is asleep. */
export function asleepToolOf(entries: readonly Entry[]): ToolEntry | null {
  for (const entry of entries)
    if (entry.kind === "tool" && asleepToolFailure(entry as ToolEntry, []) !== null)
      return entry as ToolEntry;
  return null;
}

/**
 * Under a step whose Device was asleep: "Couldn't reach {device}: asleep", and on a Mac Home
 * only, the Cloud Computer suggestion with Not now.
 */
export function AsleepActivityLine(props: { readonly tool: ToolEntry }): ReactNode {
  const computers = useContext(TranscriptComputersContext);
  const failure = asleepToolFailure(props.tool, computers?.machines ?? []);
  if (failure === null) return null;
  return computers === null ? (
    <View style={styles.line}>
      <AsleepMoment
        homeKind={null}
        line={failure.line}
        lineAlways
        moment={`tool:${props.tool.callId}`}
        onOpenCloudComputer={() => undefined}
      />
    </View>
  ) : (
    <WithHome hostClient={computers.hostClient} line={failure.line} tool={props.tool} />
  );
}

function WithHome(props: {
  readonly hostClient: HostClient;
  readonly line: string;
  readonly tool: ToolEntry;
}): ReactNode {
  const navigation = useNavigation();
  const home = usePhoneHome({
    exposure: useHostSelector(props.hostClient, selectHomeExposure),
    homeKind: useHostSelector(props.hostClient, selectHomeKind),
    deploymentId: useHostSelector(props.hostClient, selectHomeDeploymentId),
  }).kind;
  return (
    <View style={styles.line}>
      <AsleepMoment
        homeKind={home.kind}
        line={props.line}
        lineAlways
        moment={`tool:${props.tool.callId}`}
        onOpenCloudComputer={() => navigation.navigate("CloudComputer")}
      />
    </View>
  );
}

const styles = StyleSheet.create({ line: { paddingLeft: space[24], paddingTop: space[4] } });
