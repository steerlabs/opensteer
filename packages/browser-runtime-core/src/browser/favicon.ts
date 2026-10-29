import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BrowserFaviconSchema } from "@opensteer/protocol/browser";
import { createBoundedResponseReader } from "@opensteer/shared/boundedJson";
import type { CdpSession } from "./backend.js";

const sourceLimit = 1_024 * 1_024;
const worldName = "opensteer-favicon";
const planSchema = z.object({ key: z.string().max(64), count: z.number().int().min(0).max(9) });
const resultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("icon"), icon: BrowserFaviconSchema }),
  z.object({ kind: z.literal("opaque") }),
  z.object({ kind: z.literal("miss") }),
]);
interface IconDocument {
  id: string;
  url: string;
  contextId: number | null;
  marker: string;
}
interface IconRequest {
  document: IconDocument;
  id: string | null;
  bytes: number;
  status: number;
  mime: string;
  terminal: ReturnType<typeof Promise.withResolvers<boolean>>;
}

/** One owner for a page's icon work, including work suspended by a renderer dialog. */
export class PageFavicon {
  readonly #cdp: CdpSession;
  readonly #frameId: string;
  readonly #publish: (icon: string | null) => void;
  readonly #binding = `opensteerFavicon_${randomUUID().replaceAll("-", "")}`;
  #document: IconDocument | null = null;
  #initialized: Promise<void> | null = null;
  #running: Promise<void> | null = null;
  #rpc: Promise<unknown> | null = null;
  #request: IconRequest | null = null;
  #dirty = false;
  #force = false;
  #closed = false;
  #dialog = false;
  #revision = 0;
  #lastKey: string | null = null;
  #attemptKey: string | null = null;
  #attempts = 0;
  #retryAfter = 0;
  #nextRead = 0;
  #wake: ReturnType<typeof setTimeout> | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  #expired = false;

  constructor(cdp: CdpSession, frameId: string, publish: (icon: string | null) => void) {
    this.#cdp = cdp;
    this.#frameId = frameId;
    this.#publish = publish;
    cdp.on("Runtime.bindingCalled", this.#onBinding);
    cdp.on("Network.requestWillBeSent", this.#onRequest);
    cdp.on("Network.responseReceived", this.#onResponse);
    cdp.on("Network.dataReceived", this.#onData);
    cdp.on("Network.loadingFinished", this.#onFinished);
    cdp.on("Network.loadingFailed", this.#onFailed);
  }

  refresh(id: string, url: string): void {
    if (this.#closed) return;
    if (this.#document?.id !== id) {
      this.#revision++;
      this.#request?.terminal.resolve(false);
      this.#document = { id, url, contextId: null, marker: `opensteer-favicon-${randomUUID()}.js` };
      this.#lastKey = this.#attemptKey = null;
      this.#retryAfter = 0;
      this.#nextRead = 0;
      this.#clearWake();
    } else {
      this.#document.url = url;
      if (this.#retryAfter && Date.now() >= this.#retryAfter) {
        this.#attemptKey = null;
        this.#force = true;
        this.#retryAfter = 0;
      }
    }
    this.#dirty = true;
    this.#pump();
  }

  dialog(open: boolean): void {
    this.#dialog = open;
    if (!open) {
      if (this.#retryAfter) this.#attemptKey = null;
      this.#dirty = this.#force = true;
      this.#pump();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#revision++;
    this.#clearWake();
    if (this.#deadline) clearTimeout(this.#deadline);
    this.#request?.terminal.resolve(false);
    this.#cdp.off("Runtime.bindingCalled", this.#onBinding);
    this.#cdp.off("Network.requestWillBeSent", this.#onRequest);
    this.#cdp.off("Network.responseReceived", this.#onResponse);
    this.#cdp.off("Network.dataReceived", this.#onData);
    this.#cdp.off("Network.loadingFinished", this.#onFinished);
    this.#cdp.off("Network.loadingFailed", this.#onFailed);
    const document = this.#document;
    // Dispatch terminal cleanup before detaching, including when a read awaits
    // a response. A modal renderer may not acknowledge it until it resumes.
    const stop =
      document?.contextId === null || !document
        ? Promise.resolve()
        : this.#cdp.send("Runtime.evaluate", {
            contextId: document.contextId,
            expression: "globalThis.iconOwner?.stop()",
            silent: true,
          });
    const remove = this.#cdp.send("Runtime.removeBinding", { name: this.#binding });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([stop, remove]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 250);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #clearWake(): void {
    if (this.#wake) clearTimeout(this.#wake);
    this.#wake = null;
  }

  #pump(): void {
    if (this.#running || this.#closed || this.#dialog || !this.#dirty) return;
    const delay = this.#nextRead - Date.now();
    if (delay > 0) {
      this.#wake ??= setTimeout(() => {
        this.#wake = null;
        this.#pump();
      }, delay);
      return;
    }
    this.#running = this.#drain()
      .catch(() => undefined)
      .finally(() => {
        this.#running = null;
        this.#pump();
      });
  }

  async #drain(): Promise<void> {
    while (this.#dirty && !this.#closed && !this.#dialog) {
      if (Date.now() < this.#nextRead) return;
      this.#nextRead = Date.now() + 1_000;
      this.#dirty = false;
      let force = this.#force;
      this.#force = false;
      const document = this.#document;
      if (!document || !/^https?:/i.test(document.url)) continue;
      this.#expired = false;
      let network = false;
      this.#deadline = setTimeout(() => {
        this.#expired = true;
        if (this.#document === document && !this.#closed && this.#lastKey === null)
          this.#publish(null);
        // A paused renderer cannot acknowledge abort. Do not open another job
        // slot until the existing RPC or request actually settles.
        if (!this.#rpc && !this.#dialog) void this.#abort(document).catch(() => undefined);
      }, 8_000);
      try {
        await this.#prepare(document);
        if (this.#document !== document || this.#closed || this.#expired) continue;
        force ||= this.#force;
        this.#dirty = this.#force = false;
        const revision = this.#revision;
        const plan = planSchema.parse(
          await this.#evaluate(document, "globalThis.iconOwner.plan()"),
        );
        if (revision !== this.#revision || plan.count === 0) continue;
        const key = `${document.id}:${plan.key}`;
        if (key === this.#lastKey && !force) continue;
        // Lease only during acquisition; Electron keeps other subscribers'
        // settings and releases the domain only after its last owner leaves.
        await this.#cdp.send("Network.enable");
        network = true;
        this.#attempts = this.#attemptKey === key ? this.#attempts + 1 : 1;
        this.#attemptKey = key;
        let icon: string | null = null;
        let selected = -1;
        for (let index = 0; index < plan.count; index++) {
          if (
            this.#closed ||
            this.#expired ||
            this.#document !== document ||
            revision !== this.#revision
          )
            break;
          this.#request = {
            document,
            id: null,
            bytes: 0,
            status: 0,
            mime: "",
            terminal: Promise.withResolvers<boolean>(),
          };
          try {
            const result = resultSchema.parse(
              await this.#evaluate(document, `globalThis.iconOwner.read(${index})`),
            );
            if (result.kind === "icon") icon = result.icon;
            else if (result.kind === "opaque") icon = await this.#opaqueIcon(this.#request);
          } catch {
            icon = null;
          } finally {
            await this.#abort(document).catch(() => undefined);
            this.#request = null;
          }
          if (icon !== null) {
            selected = index;
            break;
          }
        }
        if (
          !this.#closed &&
          !this.#expired &&
          this.#document === document &&
          revision === this.#revision
        ) {
          this.#lastKey = key;
          this.#retryAfter = icon === null || selected > 0 ? Date.now() + 5_000 : 0;
          this.#publish(icon);
          // A fallback is useful display content, not proof that a preferred
          // authenticated/temporarily unavailable candidate cannot recover.
          if ((icon === null || selected > 0) && this.#attempts < 2) {
            this.#clearWake();
            this.#wake = setTimeout(() => {
              this.#wake = null;
              this.#dirty = this.#force = true;
              this.#pump();
            }, 750);
          }
        }
      } finally {
        if (network) await this.#cdp.send("Network.disable").catch(() => undefined);
        if (this.#deadline) clearTimeout(this.#deadline);
        this.#deadline = null;
      }
    }
  }

  async #prepare(document: IconDocument): Promise<void> {
    this.#initialized ??= (async () => {
      await this.#cdp.send("Runtime.enable");
      if (this.#closed) return;
      await this.#cdp.send("Runtime.addBinding", {
        name: this.#binding,
        executionContextName: worldName,
      });
    })().catch((error: unknown) => {
      this.#initialized = null;
      throw error;
    });
    await this.#initialized;
    if (document.contextId !== null || this.#document !== document || this.#closed) return;
    const world = z.object({ executionContextId: z.number().int() }).parse(
      await this.#cdp.send("Page.createIsolatedWorld", {
        frameId: this.#frameId,
        worldName,
        grantUniveralAccess: false,
        // Synchronous SVG image decoding checks the current world's inline CSS policy.
        contentSecurityPolicy:
          "default-src 'none'; connect-src http: https: data: blob:; img-src data: blob:; style-src 'unsafe-inline'",
      }),
    );
    if (this.#closed || this.#document !== document) return;
    document.contextId = world.executionContextId;
    try {
      await this.#evaluate(
        document,
        `(${pageScript})(${JSON.stringify(this.#binding)}, ${sourceLimit})\n//# sourceURL=${document.marker}`,
      );
    } catch (error) {
      document.contextId = null;
      throw error;
    }
  }

  async #evaluate(document: IconDocument, expression: string): Promise<unknown> {
    while (this.#rpc) await this.#rpc.catch(() => undefined);
    const rpc = this.#cdp.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      {
        contextId: document.contextId,
        expression,
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      },
    );
    this.#rpc = rpc;
    try {
      const response = await rpc;
      if (response.exceptionDetails) throw new Error("The icon's document is no longer available.");
      return response.result?.value;
    } finally {
      if (this.#rpc === rpc) this.#rpc = null;
    }
  }

  async #abort(document: IconDocument): Promise<void> {
    if (document.contextId !== null)
      await this.#evaluate(document, "globalThis.iconOwner?.abort()");
  }

  async #opaqueIcon(request: IconRequest): Promise<string | null> {
    if (
      !request.id ||
      !(await request.terminal.promise) ||
      this.#expired ||
      request.bytes > sourceLimit ||
      request.status !== 200
    )
      return null;
    const body = z
      .object({ body: z.string().max(Math.ceil(sourceLimit / 3) * 4), base64Encoded: z.boolean() })
      .parse(await this.#cdp.send("Network.getResponseBody", { requestId: request.id }));
    const bytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
    if (bytes.length > sourceLimit) return null;
    const svg =
      request.mime === "image/svg+xml" ||
      /^\s*(?:<\?xml[^>]*>\s*|<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.toString("utf8"));
    const source = `data:${svg ? "image/svg+xml" : "image/png"};base64,${bytes.toString("base64")}`;
    const result = BrowserFaviconSchema.safeParse(
      await this.#evaluate(
        request.document,
        `globalThis.iconOwner.normalize(${JSON.stringify(source)})`,
      ),
    );
    return result.success ? result.data : null;
  }

  readonly #onBinding = (value: unknown): void => {
    const event = z
      .object({ name: z.string(), executionContextId: z.number(), payload: z.string() })
      .safeParse(value);
    if (
      !event.success ||
      event.data.name !== this.#binding ||
      event.data.executionContextId !== this.#document?.contextId ||
      this.#closed
    )
      return;
    if (event.data.payload === "changed") {
      this.#revision++;
      this.#lastKey = this.#attemptKey = null;
      this.#clearWake();
      this.#force = true;
    }
    this.#dirty = true;
    this.#pump();
  };
  readonly #onRequest = (value: unknown): void => {
    if (!this.#request) return;
    const event = z
      .object({
        requestId: z.string(),
        frameId: z.string().optional(),
        initiator: z.object({
          stack: z.object({ callFrames: z.array(z.object({ url: z.string() })) }).optional(),
        }),
      })
      .safeParse(value);
    const request = this.#request;
    if (
      !event.success ||
      !request ||
      event.data.frameId !== this.#frameId ||
      request.document !== this.#document
    )
      return;
    if (event.data.requestId === request.id) return; // Redirects retain ownership.
    if (
      event.data.initiator.stack?.callFrames.some((frame) => frame.url === request.document.marker)
    ) {
      if (request.id !== null) {
        request.terminal.resolve(false);
        return;
      }
      request.id = event.data.requestId;
    }
  };
  readonly #onResponse = (value: unknown): void => {
    if (!this.#request) return;
    const event = z
      .object({
        requestId: z.string(),
        response: z.object({ status: z.number(), mimeType: z.string() }),
      })
      .safeParse(value);
    if (event.success && event.data.requestId === this.#request?.id) {
      this.#request.status = event.data.response.status;
      this.#request.mime = event.data.response.mimeType;
    }
  };
  readonly #onData = (value: unknown): void => {
    if (!this.#request) return;
    const event = z
      .object({ requestId: z.string(), dataLength: z.number().nonnegative() })
      .safeParse(value);
    if (!event.success || event.data.requestId !== this.#request?.id) return;
    this.#request.bytes += event.data.dataLength;
    if (this.#request.bytes > sourceLimit && !this.#rpc && !this.#dialog)
      void this.#abort(this.#request.document).catch(() => undefined);
  };
  readonly #onFinished = (value: unknown): void => {
    this.#finish(value, true);
  };
  readonly #onFailed = (value: unknown): void => {
    this.#finish(value, false);
  };
  #finish(value: unknown, success: boolean): void {
    if (!this.#request) return;
    const event = z.object({ requestId: z.string() }).safeParse(value);
    if (event.success && event.data.requestId === this.#request?.id)
      this.#request.terminal.resolve(success);
  }
}

// Serialized into a private world. Candidate URLs, including data URLs, stay
// there; only a compact plan key and a normalized raster cross the boundary.
const pageScript = `(binding, limit) => {
  globalThis.iconOwner?.stop();
  const {readBoundedResponse}=(${createBoundedResponseReader.toString()})();
  let urls = [], signature, queued = false, media = [], controller, timer;
  const candidates = () => {
    const distance = link => {
      if (link.sizes.contains('any')) return 0;
      const sizes = [...link.sizes].map(size => /^(\\d+)x\\1$/i.exec(size)).filter(Boolean);
      return sizes.length ? Math.min(...sizes.map(size => Math.abs(Number(size[1])-32))) : 16;
    };
    const links = [...document.querySelectorAll('link[rel~="icon" i][href]')]
      .filter(link => (!link.media || matchMedia(link.media).matches) && /^(https?:|data:image\\/|blob:)/i.test(link.href) && link.href.length <= limit*2)
      .map((link,index)=>({url:link.href,distance:distance(link),index}))
      .sort((a,b)=>a.distance-b.distance || b.index-a.index).slice(0,8).map(link=>link.url);
    return [...new Set([...links, new URL('/favicon.ico',location.href).href])];
  };
  const key = list => {
    let hash = 2166136261;
    for (const url of list) { for (let i=0;i<url.length;i++) hash=Math.imul(hash^url.charCodeAt(i),16777619); hash=Math.imul(hash^0,16777619); }
    return list.length+':'+(hash>>>0)+':'+matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const notify = force => {
    queued=false;
    if (document.readyState==='loading') return;
    const next=key(candidates());
    for(const query of media) query.removeEventListener('change',schedule);
    media=[...new Set(['(prefers-color-scheme: dark)',...[...document.querySelectorAll('link[rel~="icon" i][media]')].map(link=>link.media)])].map(value=>matchMedia(value));
    for(const query of media) query.addEventListener('change',schedule);
    if(next!==signature || force===true) { signature=next; globalThis[binding]('changed'); }
  };
  const schedule = () => { if(!queued) {queued=true;queueMicrotask(notify);} };
  const observer=new MutationObserver(mutations=>{
    if(mutations.some(mutation=> /^(LINK|BASE)$/.test(mutation.target.nodeName) ||
      [...mutation.addedNodes,...mutation.removedNodes].some(node=>/^(HEAD|LINK|BASE)$/.test(node.nodeName)||node.querySelector?.('link,base')))) schedule();
  });
  observer.observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['href','rel','sizes','type','media']});
  const loaded=()=>globalThis[binding]('loaded');
  document.addEventListener('DOMContentLoaded',notify,{once:true});
  window.addEventListener('load',loaded,{once:true});
  const abort=()=>{ clearTimeout(timer); controller?.abort(); controller=undefined; };
  const normalize=source=>new Promise(resolve=>{
    const image=new Image();
    const done=value=>{clearTimeout(deadline);image.onload=image.onerror=null;image.src='';resolve(value)};
    const deadline=setTimeout(()=>done(null),1500);
    image.onerror=()=>done(null);
    image.onload=()=>{
      if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth>4096||image.naturalHeight>4096) return done(null);
      try {
        const canvas=document.createElement('canvas');canvas.width=canvas.height=32;
        const scale=32/Math.max(image.naturalWidth,image.naturalHeight);
        const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
        canvas.getContext('2d').drawImage(image,(32-width)/2,(32-height)/2,width,height);
        done(canvas.toDataURL('image/png'));
      } catch {done(null)}
    };
    image.src=source;
  });
  globalThis.iconOwner={
    plan(){ urls=document.readyState==='loading'?[]:candidates(); return {key:key(urls),count:urls.length}; },
    async read(index){
      abort();controller=new AbortController();timer=setTimeout(abort,1500);
      try {
        const response=await fetch(urls[index],{mode:'no-cors',credentials:'include',signal:controller.signal});
        if(response.type==='opaque') return {kind:'opaque'};
        if(!response.ok||!response.body) return {kind:'miss'};
        const bytes=await readBoundedResponse(response,{maximumBytes:limit,signal:controller.signal});
        const blob=new Blob([bytes],{type:response.headers.get('content-type')||''});
        const source=URL.createObjectURL(blob);
        try {const icon=await normalize(source);return icon?{kind:'icon',icon}:{kind:'miss'};}
        finally{URL.revokeObjectURL(source);}
      }catch{return {kind:'miss'}}
    },normalize,abort,
    stop(){abort();observer.disconnect();for(const query of media)query.removeEventListener('change',schedule);document.removeEventListener('DOMContentLoaded',notify);window.removeEventListener('load',loaded);}
  };
  notify();
}`;
