import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createId, type TaskFolder } from "@opensteer/core";
import { hostApiVersion, hostApiVersionHeader } from "@opensteer/deployment-authority";
import {
  cloneTestDatabase,
  ownTestDatabaseProducer,
} from "@opensteer/database/test-support/database";
import {
  PersonalRemoteAccessStatusSchema,
  type ConfigurePersonalRemoteAccessRequest,
  type RunnerModuleName,
} from "@opensteer/protocol";
import type { MachineAccessHost } from "./machine-access.test-support.js";
import { startPersonalRuntime } from "./personal-startup.test-support.js";

export const nativeFsHelperBinary = resolve(
  "apps/runner/native-fs-helper/opensteer-native-fs-test",
);

export async function createMachineAccessDatabase(serverUrl: string) {
  return cloneTestDatabase("host", { serverUrl });
}

export async function configurePersonalRemoteAccess(
  host: Pick<MachineAccessHost, "runtime" | "ownerHeaders">,
  input: ConfigurePersonalRemoteAccessRequest,
) {
  const response = await host.runtime.app.inject({
    method: "PUT",
    url: "/v1/personal-remote-access",
    headers: { ...host.ownerHeaders, [hostApiVersionHeader]: String(hostApiVersion) },
    payload: input,
  });
  if (response.statusCode !== 200)
    throw new Error(`Remote access configuration failed: ${response.body}`);
  return PersonalRemoteAccessStatusSchema.parse(response.json());
}

export async function enrollmentToken(
  host: Pick<MachineAccessHost, "api">,
  input: {
    readonly allowedModules: readonly RunnerModuleName[];
    readonly idempotencyKey: string;
    readonly name: string;
  },
) {
  const response = await host.api["commands.dispatch"]({
    type: "runner.enrollment.createLocal",
    ...input,
    allowedModules: [...input.allowedModules],
  });
  if (!response.ok) throw new Error(response.error.message);
  if (response.data.type !== "runner.enrollment.createLocal")
    throw new Error("Runner enrollment receipt mismatch");
  return response.data.token;
}

export async function startPersonalMachineHost(input: {
  readonly databaseUrl: string;
  readonly agentHome?: TaskFolder;
  readonly remoteAccess?: boolean;
  readonly browser?: Parameters<typeof startPersonalRuntime>[0]["browser"];
}): Promise<MachineAccessHost> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "personal-machines-")));
  let personal: Awaited<ReturnType<typeof startPersonalRuntime>> | undefined;
  try {
    const owned = await ownTestDatabaseProducer(input.databaseUrl, async () => {
      const runtime = await startPersonalRuntime({
        databaseUrl: input.databaseUrl,
        agentHome: input.agentHome ?? {
          computerId: createId("runner"),
          path: join(directory, "home"),
        },
        ...(input.browser ? { browser: input.browser } : {}),
      });
      return { runtime, close: () => runtime.close() };
    });
    personal = owned.runtime;
    const current = personal;
    const settings = await current.host.store.database
      .selectFrom("personalSettings")
      .select("ownerId")
      .executeTakeFirstOrThrow();
    const host: MachineAccessHost = {
      api: current.api,
      ownerId: settings.ownerId,
      hostingComputerId: current.agentHome.computerId,
      agentHome: current.agentHome,
      origin: current.hostOrigin,
      config: current.config,
      remoteAccess: input.remoteAccess ?? false,
      hostPort: Number(current.hostOrigin.port),
      get ownerHeaders() {
        return {
          cookie: current.sessionCookie,
          origin: current.hostOrigin.origin,
          [hostApiVersionHeader]: String(hostApiVersion),
        };
      },
      get runtime() {
        return current.host;
      },
      get store() {
        return current.host.store;
      },
      async close() {
        try {
          await current.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
    if (input.remoteAccess)
      await configurePersonalRemoteAccess(host, {
        schemaVersion: 1,
        mode: "private",
        routeOrigin: "https://personal.machine-access.test",
      });
    return host;
  } catch (error) {
    try {
      await personal?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
