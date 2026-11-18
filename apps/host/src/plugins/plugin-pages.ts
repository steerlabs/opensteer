import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { UserId } from "@opensteer/core";
import { OpensteerError, appMaxBytes } from "@opensteer/core";
import { appFrameHeaders, prepareAppHtml } from "@opensteer/shared/appFrame";
import { readBoundedResponse } from "@opensteer/shared/boundedJson";
import type { AppService } from "../apps/app-service.js";
import {
  appCorsHeaders,
  appOriginRequestHeaders,
  appOriginResponseHeaders,
  appProxyHeaders,
  appRequestPath,
} from "../apps/app-proxy.js";
import type { PluginService } from "./plugin-service.js";

const unavailable = () =>
  new OpensteerError({ code: "not_found", message: "Plugin page is unavailable" });
const owner = { caller: "personal", mode: "automatic" } as const;
type PageResponseInput = Parameters<AppService["response"]>[0];

/** A second gateway target, with the same owner viewing boundary and response isolation. */
export class PluginPages {
  readonly #views = new Map<string, { plugin: string; user: UserId }>();
  readonly #tokens = new Map<string, string>();
  readonly options: {
    service: PluginService;
    assertOwner: (user: UserId) => Promise<void>;
    access: (user: UserId, plugin: string) => Promise<"all" | "read-only" | "off">;
  };
  constructor(options: {
    service: PluginService;
    assertOwner: (user: UserId) => Promise<void>;
    access: (user: UserId, plugin: string) => Promise<"all" | "read-only" | "off">;
  }) {
    this.options = options;
  }
  forget(plugin: string) {
    for (const [token, view] of this.#views)
      if (view.plugin === plugin) {
        this.#views.delete(token);
        this.#tokens.delete(`${view.user}:${plugin}`);
      }
  }
  async authorize(user: UserId, plugin: string) {
    await this.options.assertOwner(user);
    const entry = await this.options.service.skillCache.get(plugin);
    if (!entry?.hasPage || (await this.options.access(user, plugin)) === "off") throw unavailable();
  }
  async view(user: UserId, plugin: string, theme: "light" | "dark") {
    await this.authorize(user, plugin);
    const pair = `${user}:${plugin}`;
    const token = this.#tokens.get(pair) ?? randomBytes(32).toString("base64url");
    this.#tokens.set(pair, token);
    this.#views.set(token, { plugin, user });
    return { path: `/v1/plugin-pages/${plugin}/${theme}/${token}/` };
  }
  async authorizeView(plugin: string, token: string) {
    const view = this.#views.get(token);
    if (!view || view.plugin !== plugin) throw unavailable();
    await this.authorize(view.user, plugin);
    return view;
  }
  async response(input: PageResponseInput) {
    const user = input.originMode
      ? input.userId
      : (await this.authorizeView(input.appId, input.token ?? "")).user;
    if (!user) throw unavailable();
    await this.authorize(user, input.appId);
    appRequestPath(input.path);
    const headers = input.originMode
      ? appOriginRequestHeaders(input.headers)
      : appProxyHeaders(input.headers);
    delete headers["accept-encoding"];
    const requestBody =
      input.body && !["GET", "HEAD"].includes(input.method)
        ? await readBoundedResponse(
            new Response(Readable.toWeb(input.body) as ReadableStream<Uint8Array>),
            {
              maximumBytes: 1024 * 1024,
              signal: input.signal,
              sizeError: () =>
                Object.assign(new Error("Plugin page request exceeds 1 MiB"), { statusCode: 413 }),
            },
          )
        : new Uint8Array();
    const raw = await this.options.service.page(
      {
        plugin: input.appId,
        request: {
          url: new URL(input.path, input.originMode?.origin ?? "http://plugin-page.internal").href,
          method: input.method,
          headers: Object.fromEntries(
            Object.entries(headers).map(([name, value]) => [
              name,
              Array.isArray(value) ? value.join(", ") : value,
            ]),
          ),
          body: Buffer.from(requestBody).toString("base64"),
        },
      },
      owner,
      input.signal,
    );
    const outgoing = input.originMode
      ? appOriginResponseHeaders(raw.headers, input.originMode)
      : {
          ...appProxyHeaders(raw.headers),
          ...appFrameHeaders(),
          ...appCorsHeaders,
          "content-type": raw.headers["content-type"] ?? "application/octet-stream",
        };
    if (input.method === "HEAD") {
      if (raw.stream) this.options.service.discardStream(raw.stream);
      return { status: raw.status, headers: outgoing, body: Readable.from([]) };
    }
    const stream = raw.stream
      ? Readable.from(this.options.service.readStream(raw.stream, input.signal))
      : Readable.from([Buffer.from(raw.body, "base64")]);
    if (/^text\/html(?:;|$)/iu.test(raw.headers["content-type"] ?? "") && input.method !== "HEAD") {
      let html = Buffer.from(
        await readBoundedResponse(
          new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>),
          { maximumBytes: appMaxBytes, signal: input.signal },
        ),
      ).toString("utf8");
      if (input.prefix) html = capabilityDocument(html, input.prefix);
      html = prepareAppHtml(html, input.theme, !!input.originMode);
      outgoing["content-length"] = String(Buffer.byteLength(html));
      return { status: raw.status, headers: outgoing, body: Readable.from([html]) };
    }
    return {
      status: raw.status,
      headers: outgoing,
      body: stream,
    };
  }
}

function capabilityDocument(html: string, prefix: string) {
  // Packaged resource URLs are absolute; opaque frames must keep their HTTP inside this capability.
  const script = `<script>(()=>{const prefix=${JSON.stringify(prefix)}, root=location.origin;const path=x=>{const u=new URL(x,location.href);return u.origin===root&&!u.pathname.startsWith(prefix+'/')?root+prefix+u.pathname+u.search+u.hash:u.href;};const request=window.fetch;window.fetch=(x,init)=>request(typeof x==='string'||x instanceof URL?path(x):new Request(path(x.url),x),init);const events=window.EventSource;window.EventSource=class extends events{constructor(url,init){super(path(url),init)}};})();</script>`;
  return html
    .replace(
      /(<(?:script|link|img|source)\b[^>]*\b(?:src|href)=['"])(\/[^/'"])/giu,
      `$1${prefix}$2`,
    )
    .replace(/<head(?:\s[^>]*)?>/iu, (head) => head + script);
}
