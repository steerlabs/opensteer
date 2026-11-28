import { asleepGateLine } from "@opensteer/client/computers";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { AsleepMoment } from "../computers/cloud-suggestion.js";

/**
 * Under "Can't reach" for a Mac Home only: it may be asleep, and a Cloud Computer keeps agents
 * working while it sleeps. Never for a server or a Cloud Computer.
 */
export function GateAsleepLine(props: {
  readonly deploymentId: string;
  readonly macHome: boolean;
  readonly name: string;
}): ReactNode {
  const navigation = useNavigation();
  const homeKind = props.macHome ? ("mac" as const) : null;
  const line = asleepGateLine({ macName: props.name, homeKind });
  if (line === null) return null;
  return (
    <AsleepMoment
      centered
      homeKind={homeKind}
      line={line}
      lineAlways={false}
      moment={`gate:${props.deploymentId}`}
      onOpenCloudComputer={() => navigation.navigate("CloudComputer")}
    />
  );
}
