import { DeploymentIdSchema, type DeploymentId } from "@opensteer/core";
import type { HostTransport } from "@opensteer/client/connections";
import { streamBoundedResponse } from "@opensteer/shared/responseStream";

const headersAllowed = [
  "content-type",
  "content-length",
  "cache-control",
  "etag",
  "x-content-type-options",
  "content-security-policy",
];
export function forwardMedia(
  request: Request,
  transportFor: (id: DeploymentId) => Promise<Pick<HostTransport, "exchange">>,
): Promise<Response> {
  let resolve!: (r: Response) => void;
  const ready = new Promise<Response>((yes) => {
    resolve = yes;
  });
  void (async () => {
    const url = new URL(request.url);
    const match = /^\/media\/([^/]+)\/([A-Za-z0-9_.-]+)\/([^/]+)$/u.exec(url.pathname);
    if (!match || request.method !== "GET" || url.search) {
      resolve(new Response(null, { status: 404 }));
      return;
    }
    const id = DeploymentIdSchema.parse(match[1]);
    const transport = await transportFor(id);
    await transport.exchange(
      {
        method: "GET",
        path: `/media/${match[2]}/${match[3]}`,
        headers: {},
        credentials: "omit",
        expectedDeploymentId: id,
        signal: request.signal,
      },
      async (response, progress) => {
        const headers = new Headers();
        for (const name of headersAllowed) {
          const value = response.headers.get(name);
          if (value !== null) headers.set(name, value);
        }
        if (!response.body) {
          resolve(new Response(null, { status: response.status, headers }));
          return;
        }
        const { body, done } = streamBoundedResponse(response, {
          ...progress,
          maximumBytes: 64 * 1024 * 1024,
        });
        resolve(new Response(body, { status: response.status, headers }));
        await done;
      },
    );
  })().catch(() => resolve(new Response(null, { status: 404 })));
  return ready;
}
