import { isLoopbackHostname } from "@opensteer/core";
import type { HarnessDriverSummary } from "@opensteer/client/host";
import type { HarnessSourceDescriptor, ModelServer, ModelServerRuntime } from "@opensteer/protocol";
import { parseHttpEndpointBaseUrl } from "@opensteer/shared/httpEndpoint";

const runtimeNames: Record<ModelServerRuntime, string> = {
  generic: "Model server",
  lmstudio: "LM Studio",
  ollama: "Ollama",
  omlx: "oMLX",
};

/** What a person calls the server: its app's name, or "Model server" for any other. */
export function modelServerName(runtime: string | undefined): string {
  return runtime !== undefined && runtime in runtimeNames
    ? runtimeNames[runtime as ModelServerRuntime]
    : runtimeNames.generic;
}

/** The server types a person can name when the server itself did not say. */
export const modelServerRuntimeChoices = [
  { label: "OpenAI-compatible", value: "generic" },
  { label: "Ollama", value: "ollama" },
  { label: "LM Studio", value: "lmstudio" },
  { label: "oMLX", value: "omlx" },
] as const satisfies readonly { readonly label: string; readonly value: ModelServerRuntime }[];

/**
 * An engine's source for model servers: a compatible endpoint whose models
 * carry per-model settings. Accounts of it live under Model servers, not under
 * their engine, because the person thinks of the server, not the engine.
 */
export function isModelServerSource(source: HarnessSourceDescriptor | null | undefined): boolean {
  return source?.kind === "compatible-endpoint" && source.modelSettings === true;
}

/**
 * The engines that run model server accounts, in the order Connect tries
 * them: Pi can be steered mid-run, OpenCode can ask the person a question.
 * Adding a server by its address offers every one that can run here.
 */
const modelServerEngineOrder = ["pi", "opencode"] as const;

export interface ModelServerEngine {
  readonly driverKind: string;
  readonly source: HarnessSourceDescriptor;
}

/**
 * The engine Connect uses: the first in order, and only that one. When it
 * cannot run here, Connect says so and "Add a server" offers the others; a
 * quiet switch would change what the account can do.
 */
export function modelServerConnectEngine(
  drivers: readonly HarnessDriverSummary[],
  runtime: ModelServerRuntime,
): ModelServerEngine | undefined {
  return modelServerEngines(drivers, runtime).find(
    (engine) => engine.driverKind === modelServerEngineOrder[0],
  );
}

/** The engines on this work location that can talk to a server of `runtime`. */
export function modelServerEngines(
  drivers: readonly HarnessDriverSummary[],
  runtime: ModelServerRuntime,
): readonly ModelServerEngine[] {
  return modelServerEngineOrder.flatMap((driverKind) => {
    const driver = drivers.find((candidate) => candidate.driverKind === driverKind);
    if (!driver || driver.readiness === "unavailable") return [];
    const source = driver.sources.find(
      (candidate) =>
        isModelServerSource(candidate) &&
        candidate.stateKinds.includes("isolated") &&
        candidate.fields.some(
          (field) =>
            field.id === "runtime" && field.options?.some((option) => option.value === runtime),
        ),
    );
    return source ? [{ driverKind, source }] : [];
  });
}

/**
 * One server however its address was written: every loopback name is the same
 * computer, and a known server's `/v1` prefix is the same API as its root.
 */
export function modelServerKey(runtime: string | undefined, baseUrl: string): string {
  const url = parseHttpEndpointBaseUrl(baseUrl);
  if (!url) return baseUrl;
  const host = isLoopbackHostname(url.hostname) ? "127.0.0.1" : url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  const path = url.pathname.replace(/\/+$/u, "");
  return `${url.protocol}//${host}:${port}${
    runtime === undefined || runtime === "generic" ? path : path.replace(/\/(?:api\/)?v1$/u, "")
  }`;
}

/** Where the server is, as it prints its own address. */
export function modelServerAddress(baseUrl: string): string {
  const url = parseHttpEndpointBaseUrl(baseUrl);
  return url ? url.host : baseUrl;
}

/**
 * What a server found on the computer can do now, in one sentence, and what to
 * do about it when the answer is nothing.
 */
export function modelServerStateLine(server: ModelServer): string {
  const name = modelServerName(server.runtime);
  switch (server.status) {
    case "ready": {
      if (server.models === undefined) return `${name} is ready to connect.`;
      if (server.models === 0) return server.detail ?? `${name} has no models yet.`;
      const count = `${server.models} ${server.models === 1 ? "model" : "models"}`;
      if (server.runnableModels === undefined || server.runnableModels === server.models) {
        return count;
      }
      // Models that need a context size are set up right after connecting.
      return server.runnableModels === 0
        ? `${count} · ${server.detail ?? "none can run yet"}`
        : `${count} · ${server.runnableModels} ready to use`;
    }
    case "needs-key":
      return server.detail ?? `${name} asks for an API key, which you'll paste next.`;
    case "not-running":
      return server.runtime === "lmstudio"
        ? "LM Studio's server is off. Start it in LM Studio, then look again."
        : `${name} isn't running. Open it, then look again.`;
    case "unavailable":
      return server.detail ?? `${name} can't be used right now.`;
  }
}

/**
 * What a person typed, as the base URL the engine appends paths to. A bare
 * `localhost:11434` is how servers print their address, so the scheme and the
 * `/v1` every one of these serves the Chat Completions API under are filled in;
 * an address that already names a path is left as written.
 */
export function normalizeServerAddress(typed: string): string {
  const value = typed.trim();
  if (value === "") return value;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ? value : `http://${value}`;
  const url = parseHttpEndpointBaseUrl(withScheme);
  if (!url) return value;
  return url.pathname === "/" ? `${url.origin}/v1` : withScheme.replace(/\/+$/u, "");
}

/** Why an address can't be a server's base URL, or null. */
export function serverAddressProblem(typed: string): string | null {
  return parseHttpEndpointBaseUrl(normalizeServerAddress(typed))
    ? null
    : "Enter an address like 192.168.1.20:11434, without a username, password, ? or #.";
}

/**
 * The name a new server account starts with. On its own computer a server is
 * known by what it is ("Ollama"); anywhere else the address is what tells two
 * apart, and the port stays because two servers on one computer differ by
 * nothing else.
 */
export function serverAccountName(runtime: string | undefined, address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (runtime !== undefined && runtime !== "generic" && runtime in runtimeNames) {
    if (isLoopbackHostname(url.hostname)) return modelServerName(runtime);
  }
  return url.host.toLowerCase() || null;
}
