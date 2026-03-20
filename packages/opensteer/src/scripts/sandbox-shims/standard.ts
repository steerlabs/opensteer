import { createMinimalSandboxGlobals, type MinimalSandboxShimOptions } from "./minimal.js";

export interface SandboxAjaxRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface SandboxAjaxResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface SandboxAjaxDispatcher {
  dispatch(input: SandboxAjaxRequest): Promise<SandboxAjaxResponse>;
}

export interface StandardSandboxShimOptions extends MinimalSandboxShimOptions {
  readonly ajax: SandboxAjaxDispatcher;
  readonly cookies?: Readonly<Record<string, string>>;
  readonly errors: string[];
  readonly pageUrl?: string;
}

export function createStandardSandboxGlobals(
  options: StandardSandboxShimOptions,
): Record<string, unknown> {
  const globals = createMinimalSandboxGlobals(options);
  const eventApi = createEventTargetApi();
  const documentEventApi = createEventTargetApi();
  const cookieJar = new Map(Object.entries(options.cookies ?? {}));
  const localStorage = createStorageArea();
  const sessionStorage = createStorageArea();
  const locationHref = options.pageUrl ?? "https://sandbox.opensteer.invalid/";

  class SandboxEvent {
    readonly type: string;
    readonly bubbles: boolean;
    readonly detail?: unknown;

    constructor(type: string, init: { readonly bubbles?: boolean; readonly detail?: unknown } = {}) {
      this.type = type;
      this.bubbles = init.bubbles ?? false;
      this.detail = init.detail;
    }
  }

  class SandboxCustomEvent extends SandboxEvent {}

  const document = {
    URL: locationHref,
    documentURI: locationHref,
    readyState: "complete",
    createElement(tagName: string) {
      return createElementNode(tagName);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    addEventListener: documentEventApi.addEventListener,
    removeEventListener: documentEventApi.removeEventListener,
    dispatchEvent: documentEventApi.dispatchEvent,
    body: createElementNode("body"),
    head: createElementNode("head"),
    documentElement: createElementNode("html"),
    get cookie() {
      return serializeCookieJar(cookieJar);
    },
    set cookie(value: string) {
      const separator = value.indexOf("=");
      if (separator <= 0) {
        return;
      }
      const name = value.slice(0, separator).trim();
      const cookieValue = value.slice(separator + 1).split(";")[0]?.trim() ?? "";
      if (name.length === 0) {
        return;
      }
      cookieJar.set(name, cookieValue);
    },
  };

  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request = normalizeFetchRequest(input, init);
    const response = await options.ajax.dispatch(request);
    return new Response(response.body ?? "", {
      status: response.status,
      ...(response.headers === undefined ? {} : { headers: response.headers }),
    });
  };

  class XMLHttpRequest {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;

    readyState = XMLHttpRequest.UNSENT;
    status = 0;
    responseText = "";
    responseURL = "";
    onreadystatechange: ((this: XMLHttpRequest, event: SandboxEvent) => void) | null = null;
    onload: ((this: XMLHttpRequest, event: SandboxEvent) => void) | null = null;
    onerror: ((this: XMLHttpRequest, event: SandboxEvent) => void) | null = null;
    private readonly listeners = createEventTargetApi();
    private method = "GET";
    private url = "";
    private readonly headers = new Map<string, string>();

    open(method: string, url: string): void {
      this.method = method;
      this.url = new URL(url, locationHref).toString();
      this.readyState = XMLHttpRequest.OPENED;
      this.fire("readystatechange");
    }

    setRequestHeader(name: string, value: string): void {
      this.headers.set(name, value);
    }

    addEventListener(type: string, listener: (...args: unknown[]) => void): void {
      this.listeners.addEventListener(type, listener);
    }

    removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
      this.listeners.removeEventListener(type, listener);
    }

    async send(body?: unknown): Promise<void> {
      try {
        const response = await options.ajax.dispatch({
          method: this.method,
          url: this.url,
          headers: Object.fromEntries(this.headers),
          ...(body === undefined ? {} : { body: normalizeBody(body) }),
        });
        this.readyState = XMLHttpRequest.DONE;
        this.status = response.status;
        this.responseURL = this.url;
        this.responseText = response.body ?? "";
        this.fire("readystatechange");
        this.fire("load");
      } catch (error) {
        this.readyState = XMLHttpRequest.DONE;
        options.errors.push(normalizeErrorMessage(error));
        this.fire("readystatechange");
        this.fire("error");
      }
    }

    getResponseHeader(name: string): string | null {
      return null;
    }

    getAllResponseHeaders(): string {
      return "";
    }

    private fire(type: string): void {
      const event = new SandboxEvent(type);
      try {
        if (type === "readystatechange") {
          this.onreadystatechange?.call(this, event);
        } else if (type === "load") {
          this.onload?.call(this, event);
        } else if (type === "error") {
          this.onerror?.call(this, event);
        }
        this.listeners.dispatchEvent(event);
      } catch (error) {
        options.errors.push(normalizeErrorMessage(error));
      }
    }
  }

  return {
    ...globals,
    Event: SandboxEvent,
    CustomEvent: SandboxCustomEvent,
    Headers,
    Request,
    Response,
    EventTarget,
    fetch,
    XMLHttpRequest,
    addEventListener: eventApi.addEventListener,
    removeEventListener: eventApi.removeEventListener,
    dispatchEvent: eventApi.dispatchEvent,
    localStorage,
    sessionStorage,
    document,
    location: new URL(locationHref),
    navigator: {
      userAgent: "OpensteerSandbox/1.0",
      language: "en-US",
      languages: ["en-US"],
      platform: "Linux x86_64",
      cookieEnabled: true,
      maxTouchPoints: 0,
    },
    performance: {
      now: () => options.clock.performanceNow(),
    },
  };
}

function createElementNode(tagName: string): Record<string, unknown> {
  const eventApi = createEventTargetApi();
  return {
    tagName: tagName.toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    appendChild(child: unknown) {
      (this.children as unknown[]).push(child);
      return child;
    },
    remove() {
      return undefined;
    },
    setAttribute(name: string, value: string) {
      (this as Record<string, unknown>)[name] = value;
    },
    getAttribute(name: string) {
      const value = (this as Record<string, unknown>)[name];
      return typeof value === "string" ? value : null;
    },
    addEventListener: eventApi.addEventListener,
    removeEventListener: eventApi.removeEventListener,
    dispatchEvent: eventApi.dispatchEvent,
  };
}

function createEventTargetApi(): {
  readonly addEventListener: (type: string, listener: (...args: unknown[]) => void) => void;
  readonly removeEventListener: (type: string, listener: (...args: unknown[]) => void) => void;
  readonly dispatchEvent: (event: { readonly type: string }) => boolean;
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? new Set<(...args: unknown[]) => void>();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      for (const listener of listeners.get(event.type) ?? []) {
        listener(event);
      }
      return true;
    },
  };
}

function createStorageArea(): Storage {
  const storage = new Map<string, string>();
  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return [...storage.keys()][index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

function normalizeFetchRequest(input: string | URL | Request, init: RequestInit): SandboxAjaxRequest {
  const url = input instanceof URL
    ? input.toString()
    : typeof input === "string"
      ? input
      : input.url;
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  return {
    method: init.method ?? (input instanceof Request ? input.method : "GET"),
    url,
    headers: Object.fromEntries(headers.entries()),
    ...(init.body === undefined ? {} : { body: normalizeBody(init.body) }),
  };
}

function normalizeBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (body instanceof URLSearchParams) {
    return body.toString();
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body).toString("base64");
  }
  if (body instanceof ArrayBuffer) {
    return Buffer.from(body).toString("base64");
  }
  return String(body);
}

function serializeCookieJar(cookieJar: ReadonlyMap<string, string>): string {
  return [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function normalizeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
