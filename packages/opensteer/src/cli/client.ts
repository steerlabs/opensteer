import { spawn } from "node:child_process";

import {
  connectOpensteerService as connectExistingOpensteerService,
  OpensteerCliServiceError,
  OpensteerSessionServiceClient,
  requireOpensteerService as requireExistingOpensteerService,
  resolveLiveOpensteerServiceMetadata,
  type OpensteerCliSessionOptions,
} from "../session-service/client.js";
import { normalizeOpensteerSessionName } from "../session-service/metadata.js";

const SERVICE_START_TIMEOUT_MS = 10_000;
const SERVICE_POLL_INTERVAL_MS = 100;

export interface OpensteerServiceLaunchContext {
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly scriptPath: string;
  readonly cwd?: string;
}

export { OpensteerCliServiceError, OpensteerSessionServiceClient as OpensteerCliServiceClient };
export type { OpensteerCliSessionOptions } from "../session-service/client.js";

export async function connectOpensteerService(
  options: OpensteerCliSessionOptions = {},
) {
  return connectExistingOpensteerService(options);
}

export async function ensureOpensteerService(
  options: OpensteerCliSessionOptions & {
    readonly launchContext: OpensteerServiceLaunchContext;
  },
): Promise<OpensteerSessionServiceClient> {
  const existing = await connectOpensteerService(options);
  if (existing) {
    return existing;
  }

  const name = normalizeOpensteerSessionName(options.name);
  const serviceArgs = [
    ...options.launchContext.execArgv,
    options.launchContext.scriptPath,
    "service-host",
    "--name",
    name,
    ...(options.rootDir === undefined ? [] : ["--root-dir", options.rootDir]),
    ...(options.engine === undefined ? [] : ["--engine", options.engine]),
  ];
  const child = spawn(options.launchContext.execPath, serviceArgs, {
    cwd: options.launchContext.cwd ?? process.cwd(),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < SERVICE_START_TIMEOUT_MS) {
    const metadata = await resolveLiveOpensteerServiceMetadata(options);
    if (metadata) {
      return OpensteerSessionServiceClient.fromMetadata(metadata);
    }

    await wait(SERVICE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Opensteer service for "${name}" did not become ready within ${String(SERVICE_START_TIMEOUT_MS)}ms.`,
  );
}

export async function requireOpensteerService(
  options: OpensteerCliSessionOptions = {},
) {
  return requireExistingOpensteerService(options);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
