import { randomBytes } from "node:crypto";

import { startLocalViewServer } from "./server.js";

export async function runLocalViewService(): Promise<void> {
  await startLocalViewServer({
    token: process.env.OPENSTEER_LOCAL_VIEW_BOOT_TOKEN ?? randomBytes(24).toString("hex"),
  });
  await new Promise<void>(() => undefined);
}
