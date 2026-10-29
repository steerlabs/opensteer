import { parseChannelRuntimeConfig } from "./config.js";
import { createSlackAdapter } from "@opensteer/channel-slack";
import { MessagingModule } from "@opensteer/messaging-module";
import { RunnerMessagingConnection } from "./host-client.js";
import { FileRunnerIdentityStore, RunnerDataDirectoryLock } from "@opensteer/runner-client";
import { ChannelRuntimeServer } from "./server.js";

async function main(): Promise<void> {
  const config = parseChannelRuntimeConfig(process.env);
  const lock = await RunnerDataDirectoryLock.acquire(config.dataDirectory);
  // A messaging computer runs no agents, so its identity names no work location.
  const identityStore = new FileRunnerIdentityStore({
    dataDirectory: config.dataDirectory,
    environmentless: true,
  });
  const identity = await identityStore.loadOrCreate();
  // The registry is a static array on purpose: a new provider is a package,
  // one line here, and a manifest in channel-core's catalog — never a
  // per-deployment configuration knob.
  const messaging = new MessagingModule([createSlackAdapter()]);
  const host = new RunnerMessagingConnection({
    config,
    identity,
    identityStore,
    module: messaging,
    runtimeVersion: "0.0.0",
  });
  const server = new ChannelRuntimeServer({
    logger: true,
    providers: () => messaging.providers(),
    ready: () => host.authenticated,
  });
  const address = await server.app.listen({ host: config.bindAddress, port: config.port });
  host.start();
  process.stdout.write(
    `${JSON.stringify({
      event: "channel-runtime.listening",
      providers: messaging.providers(),
      url: address,
    })}\n`,
  );

  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await host.close();
    await messaging.close();
    await server.app.close();
    await lock.release();
  };
  process.once("SIGINT", () => void close().catch(fail));
  process.once("SIGTERM", () => void close().catch(fail));
  // Another process reclaimed the data directory lease: stop the same way a
  // signal stops us, but report it, because nothing asked for this shutdown.
  lock.onLost((reason) => {
    fail(reason);
    void close().catch(fail);
  });
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : "Unknown messaging service failure";
  process.stderr.write(`${JSON.stringify({ event: "channel-runtime.failed", message })}\n`);
  process.exitCode = 1;
}

void main().catch(fail);
