import { appOriginHeader } from "@opensteer/shared/appFrame";

const appHostname =
  /^[a-z2-7]{26}-([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12})\.(.+)$/u;

/**
 * Cloudflare Worker for `*.<Connect domain>`. A tunnel's ingress is one hostname, so every app
 * origin is forwarded to its Deployment's Connect hostname, and the Host authorizes it there.
 */
export default {
  fetch(request: Request): Response | Promise<Response> {
    const url = new URL(request.url);
    const match = appHostname.exec(url.hostname);
    if (!match) return new Response("App not found", { status: 404 });
    const [, first, second, third, fourth, fifth, domain] = match;
    const headers = new Headers(request.headers);
    headers.set(appOriginHeader, url.origin);
    url.hostname = `connect-${first}-${second}-${third}-${fourth}-${fifth}.${domain}`;
    return fetch(new Request(url, request), { headers, redirect: "manual" });
  },
};
