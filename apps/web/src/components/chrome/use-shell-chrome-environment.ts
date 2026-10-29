import { selectedDeploymentFrom } from "../../desktop/desktop-deployment-selection.js";
import { useShell } from "../app-shell.js";
import {
  useChromeConnectEnvironment,
  type ChromeConnectEnvironment,
} from "./chrome-environment.js";

/**
 * The environment inside the signed-in app. The packaged app knows whether it
 * runs on the Deployment's own computer; a browser tab knows only its address.
 */
export function useShellChromeEnvironment(): ChromeConnectEnvironment {
  const { deploymentAccess, desktopBridge, desktopDeployment } = useShell();
  const deployment = desktopBridge
    ? selectedDeploymentFrom(deploymentAccess, desktopDeployment)
    : null;
  return useChromeConnectEnvironment({
    desktopBridge,
    hostHere: desktopBridge ? (deployment?.onThisComputer ?? false) : null,
  });
}
