import {
  hostApi,
  hostApiVersionHeader,
  type HostApiClient,
  type RpcInput,
} from "@opensteer/protocol";
import { hostApiVersion } from "@opensteer/deployment-authority";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";

type RpcName = keyof typeof hostApi;

/** The epoch every test call states, in the one place tests read it from. */
const negotiatedHeader: Readonly<Record<string, string>> = {
  [hostApiVersionHeader]: String(hostApiVersion),
};

export async function testRpcRequest<Name extends RpcName>(
  origin: string | URL,
  name: Name,
  input: RpcInput<(typeof hostApi)[Name]>,
  init: Omit<RequestInit, "body" | "method"> = {},
): Promise<Response> {
  const declaration = hostApi[name];
  const payload = declaration.payload.parse(input);
  const url = new URL(`/v1/rpc/${name}`, origin);
  if (declaration.method === "GET") url.searchParams.set("input", JSON.stringify(payload));
  return fetch(url, {
    ...init,
    ...(declaration.method === "POST" ? { body: JSON.stringify(payload) } : {}),
    headers: {
      // A test call is an ordinary rpc caller, so it negotiates like one. A
      // test about negotiation itself overrides or drops it through `headers`.
      ...negotiatedHeader,
      ...(declaration.method === "POST" ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    method: declaration.method,
  });
}

/**
 * The same negotiated call, for a test that holds the Fastify instance rather
 * than a listening origin. The route and the query spelling come from the
 * declaration exactly as they do over HTTP, so neither injector nor fetch can
 * drift from the wire.
 */
export function injectRpcRequest(
  app: FastifyInstance,
  name: RpcName,
  input: Readonly<Record<string, unknown>>,
  headers: Readonly<Record<string, string>> = {},
): Promise<LightMyRequestResponse> {
  const declaration = hostApi[name];
  const negotiated = { ...negotiatedHeader, ...headers };
  return app.inject(
    declaration.method === "GET"
      ? {
          headers: negotiated,
          method: "GET",
          url: `/v1/rpc/${name}?input=${encodeURIComponent(JSON.stringify(input))}`,
        }
      : { headers: negotiated, method: "POST", payload: input, url: `/v1/rpc/${name}` },
  );
}

export async function testRpcData<Name extends RpcName>(
  origin: string | URL,
  name: Name,
  input: RpcInput<(typeof hostApi)[Name]>,
  init: Omit<RequestInit, "body" | "method"> = {},
): Promise<Extract<Awaited<ReturnType<HostApiClient[Name]>>, { readonly ok: true }>["data"]> {
  const response = await testRpcRequest(origin, name, input, init);
  const result: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(result)}`);
  if (
    typeof result !== "object" ||
    result === null ||
    !("ok" in result) ||
    result.ok !== true ||
    !("data" in result)
  ) {
    throw new Error("The Host returned an invalid RPC test response.");
  }
  return hostApi[name].success.parse(result.data) as Extract<
    Awaited<ReturnType<HostApiClient[Name]>>,
    { readonly ok: true }
  >["data"];
}

type ResourceDetail = Extract<
  Awaited<ReturnType<HostApiClient["resources.detail.get"]>>,
  { readonly ok: true }
>["data"]["data"];

export async function readTestResource<Kind extends ResourceDetail["kind"]>(
  api: Pick<HostApiClient, "resources.get" | "resources.detail.get">,
  kind: Kind,
): Promise<
  ResourceDetail extends infer Detail
    ? Detail extends ResourceDetail
      ? Kind extends Detail["kind"]
        ? Detail
        : never
      : never
    : never
> {
  const summary = await api["resources.get"]({ kind });
  if (!summary.ok) throw new Error(summary.error.message);
  const page = await api["resources.detail.get"]({ kind, expectedRevision: summary.data.revision });
  if (!page.ok) throw new Error(page.error.message);
  if (page.data.data.kind !== kind || page.data.next)
    throw new Error(`Expected a complete ${kind} fixture resource`);
  return page.data.data as ResourceDetail extends infer Detail
    ? Detail extends ResourceDetail
      ? Kind extends Detail["kind"]
        ? Detail
        : never
      : never
    : never;
}

export function testResourceData<Kind extends ResourceDetail["kind"]>(
  origin: string | URL,
  kind: Kind,
  init: Omit<RequestInit, "body" | "method"> = {},
) {
  return readTestResource(
    {
      "resources.get": async (input) => ({
        ok: true,
        data: await testRpcData(origin, "resources.get", input, init),
      }),
      "resources.detail.get": async (input) => ({
        ok: true,
        data: await testRpcData(origin, "resources.detail.get", input, init),
      }),
    },
    kind,
  );
}

export function injectTestResource<Kind extends ResourceDetail["kind"]>(
  app: FastifyInstance,
  kind: Kind,
  headers: Readonly<Record<string, string>> = {},
) {
  return readTestResource(
    {
      "resources.get": async (input) =>
        (await injectRpcRequest(app, "resources.get", input, headers)).json(),
      "resources.detail.get": async (input) =>
        (await injectRpcRequest(app, "resources.detail.get", input, headers)).json(),
    },
    kind,
  );
}
