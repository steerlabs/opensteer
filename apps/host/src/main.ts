import { pathToFileURL } from "node:url";
import { parseHostConfig } from "@opensteer/config";
import { createHostRuntime } from "./runtime/runtime.js";

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
    delete environment.OPENSTEER_NATIVE_MODEL_API_KEY;
    delete environment.OPENSTEER_NATIVE_MODEL_API_KEY_FILE;
  }
  const runtime = await createHostRuntime(config, {
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

  let closing = false;
  const close = async (signal: string) => {
    if (closing) return;
    closing = true;
    runtime.app.log.info({ signal }, "Opensteer Host shutting down");
    // A shutdown that hangs names the step it is waiting on.
    const slow = setInterval(
      () =>
        runtime.app.log.warn({ step: runtime.closingStep() }, "Opensteer Host still shutting down"),
      10_000,
    );
    slow.unref();
    try {
      await runtime.close();
    } finally {
      clearInterval(slow);
    }
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGBREAK", () => void close("SIGBREAK"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}

function safeRequestLog(request: { readonly method?: unknown; readonly url?: unknown }) {
  const rawUrl = typeof request.url === "string" ? request.url : "";
  return {
    method: typeof request.method === "string" ? request.method : undefined,
    path: rawUrl.split("?", 1)[0],
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
