import { shutdownSignals } from "@opensteer/shared/processControl";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

// A service that, like every Opensteer entrypoint, finishes asynchronous cleanup on any shutdown signal.
const server = createServer().listen(0, "127.0.0.1", () => process.stdout.write("ready\n"));
for (const signal of shutdownSignals)
  process.once(signal, () => {
    void delay(200).then(() => server.close(() => process.stdout.write(`closed on ${signal}\n`)));
  });
