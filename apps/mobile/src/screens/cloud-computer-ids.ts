import { cloudComputerDeployments } from "@opensteer/client/computers";
import { useCloudComputer } from "@opensteer/client/react";
import { useMemo } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";

/** The listed Homes the Account says are Opensteer Cloud Computers. */
export function useCloudComputerIds(): ReadonlySet<string> {
  const views = useCloudComputer(useMobileClient().cloudComputers ?? null).views;
  return useMemo(() => cloudComputerDeployments(views), [views]);
}
