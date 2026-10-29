import { loadControlPlaneConfig } from "./config.js";
import { startControlPlane } from "./server/runtime.js";

async function main(): Promise<void> {
  const runtime = await startControlPlane(loadControlPlaneConfig());
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void runtime.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
