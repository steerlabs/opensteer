import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
  personalUpgradeHeartbeatLine,
  personalUpgradeProgressLine,
} from "@opensteer/protocol/desktop";
import { parseHostConfig } from "@opensteer/config";
import { hostStopper } from "./runtime/host-stop.js";
import { createHostRuntime } from "./runtime/runtime.js";
import { shutdownSignals } from "@opensteer/shared/processControl";

export async function main(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  let config: ReturnType<typeof parseHostConfig>;
  try {
    config = parseHostConfig(environment);
  } finally {
    delete environment.OPENSTEER_ACCOUNT_BUNDLE_FD;
    delete environment.OPENSTEER_ACCOUNT_BUNDLE_PATH;
    delete environment.OPENSTEER_AUTH_SECRET;
    delete environment.OPENSTEER_AUTH_SECRET_FILE;
    delete environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN;
    delete environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_FILE;
    delete environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST;
    delete environment.OPENSTEER_INITIAL_OWNER_ENROLLMENT_TOKEN_DIGEST_FILE;
    delete environment.OPENSTEER_NATIVE_MODEL_API_KEY;
    delete environment.OPENSTEER_NATIVE_MODEL_API_KEY_FILE;
  }
  let lastProgressAt = -Infinity;
  let lastStage: string | undefined;
  const runtime = await createHostRuntime(config, {
    onPersonalUpgradeHeartbeat: () => {
      process.stdout.write(`${personalUpgradeHeartbeatLine}\n`);
    },
    onPersonalUpgradeBatch: (stage) => {
      const now = performance.now();
      if (stage === lastStage && now - lastProgressAt < 1_000) return;
      lastProgressAt = now;
      lastStage = stage;
      process.stdout.write(`${personalUpgradeProgressLine}\n`);
    },
    logger: {
      level: config.mode === "development" ? "debug" : "info",
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        "body.accessToken",
        "body.grant",
        "body.password",
        "body.token",
        "body.verifier",
      ],
      serializers: { req: safeRequestLog },
    },
  });
  const address = await runtime.listen();
  runtime.app.log.info({ address }, "Opensteer Host listening");

  const stopper = hostStopper(runtime);
  for (const signal of shutdownSignals) process.once(signal, () => stopper.signal(signal));
  // Only a Host that fences its database with the lifetime lock can lose it.
  if ("authorityLost" in runtime)
    void runtime.authorityLost.then((error) => stopper.authorityLost(error));
}

function safeRequestLog(request: { readonly method?: unknown; readonly url?: unknown }) {
  const rawUrl = typeof request.url === "string" ? request.url : "";
  return {
    method: typeof request.method === "string" ? request.method : undefined,
    path: rawUrl.replace(/(\/media\/)[^/?]+/gu, "$1[redacted]").split("?", 1)[0],
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
