import type { MobileClient } from "../client/mobile-client.js";
import { deploymentSignInLabel, type DeploymentRow } from "../client/deployment-rows.js";

type DeploymentRecoveryClient = Pick<
  MobileClient,
  "openDeployment" | "refreshDirectory" | "signIn" | "signInAccount"
>;

type DeploymentRecoveryNavigation = {
  navigate(route: "AddPersonal"): void;
};

/** Opens the proof door named by the row instead of retrying the failed proof. */
export async function runDeploymentRecovery(
  client: DeploymentRecoveryClient,
  navigation: DeploymentRecoveryNavigation,
  row: DeploymentRow,
): Promise<void> {
  if (row.signIn === "pairing-code") {
    navigation.navigate("AddPersonal");
    return;
  }
  if (row.sessionFailure === "account-required") {
    await client.signInAccount();
    await client.refreshDirectory();
    await client.openDeployment(row.deploymentId);
    return;
  }
  await client.signIn(row.deploymentId);
}

export function deploymentRecoveryLabel(row: DeploymentRow): string {
  if (row.signIn === "pairing-code") return "Enter a pairing code";
  if (row.sessionFailure === "account-required") return "Sign in with Opensteer";
  return row.signIn === null ? "Try again" : deploymentSignInLabel(row.signIn);
}
