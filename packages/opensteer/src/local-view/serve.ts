import { randomBytes } from "node:crypto";

import { startLocalViewServer } from "./server.js";

export async function runLocalViewService(): Promise<void> {
  const server = await startLocalViewServer({
    token: process.env.OPENSTEER_LOCAL_VIEW_BOOT_TOKEN ?? randomBytes(24).toString("hex"),
    onClosed: () => {
      process.exit(0);
    },
  });

  const handleShutdownSignal = () => {
    void server.close();
  };
  process.once("SIGINT", handleShutdownSignal);
  process.once("SIGTERM", handleShutdownSignal);

  await new Promise<void>(() => undefined);
}
