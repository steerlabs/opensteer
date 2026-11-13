import type { MobileClient } from "../client/mobile-client.js";

export async function movePhoneHere(
  client: Pick<MobileClient, "signOut">,
  elsewhere: string,
  openSetup: () => void,
): Promise<void> {
  await client.signOut(elsewhere);
  openSetup();
}
