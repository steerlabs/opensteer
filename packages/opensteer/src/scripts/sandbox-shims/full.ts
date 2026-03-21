import { createStandardSandboxGlobals, type StandardSandboxShimOptions } from "./standard.js";

export interface FullSandboxShimOptions extends StandardSandboxShimOptions {
  readonly pageUrl?: string;
}

export function createFullSandboxGlobals(options: FullSandboxShimOptions): Record<string, unknown> {
  const globals = createStandardSandboxGlobals(options);
  const eventListeners = new WeakMap<object, Map<string, Set<(...args: unknown[]) => void>>>();
  const pageUrl = new URL(options.pageUrl ?? "https://sandbox.opensteer.invalid/");

  function getListeners(target: object, type: string): Set<(...args: unknown[]) => void> {
    const byType =
      eventListeners.get(target) ?? new Map<string, Set<(...args: unknown[]) => void>>();
    eventListeners.set(target, byType);
    const current = byType.get(type) ?? new Set<(...args: unknown[]) => void>();
    byType.set(type, current);
    return current;
  }

  function makeWrapper(target: unknown) {
    const api = {
      length: target === null || target === undefined ? 0 : 1,
      on(type: string, listener: (...args: unknown[]) => void) {
        if (target !== null && typeof target === "object") {
          getListeners(target, type).add(listener);
        }
        return api;
      },
      trigger(type: string, detail?: unknown) {
        if (target !== null && typeof target === "object") {
          for (const listener of getListeners(target, type)) {
            listener({ type, detail, target });
          }
        }
        return api;
      },
      val(value?: string) {
        if (target === null || typeof target !== "object") {
          return value === undefined ? undefined : api;
        }
        if (value === undefined) {
          return (target as Record<string, unknown>).value;
        }
        (target as Record<string, unknown>).value = value;
        return api;
      },
      text(value?: string) {
        if (target === null || typeof target !== "object") {
          return value === undefined ? undefined : api;
        }
        if (value === undefined) {
          return (target as Record<string, unknown>).textContent;
        }
        (target as Record<string, unknown>).textContent = value;
        return api;
      },
      attr(name: string, value?: string) {
        if (target === null || typeof target !== "object") {
          return value === undefined ? undefined : api;
        }
        if (value === undefined) {
          return (target as Record<string, unknown>)[name];
        }
        (target as Record<string, unknown>)[name] = value;
        return api;
      },
    };
    return api;
  }

  const $ = ((target: unknown) => {
    if (
      typeof target === "string" &&
      typeof globals.document === "object" &&
      globals.document !== null
    ) {
      const querySelector = (
        globals.document as { readonly querySelector?: (selector: string) => unknown }
      ).querySelector;
      return makeWrapper(typeof querySelector === "function" ? querySelector(target) : null);
    }
    return makeWrapper(target);
  }) as ((target: unknown) => ReturnType<typeof makeWrapper>) & {
    ajax: (input: {
      readonly url: string;
      readonly method?: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly data?: unknown;
      readonly success?: (data: unknown, textStatus: string, response: Response) => void;
      readonly error?: (response: Response, textStatus: string, error: unknown) => void;
    }) => Promise<unknown>;
  };

  $.ajax = async (input) => {
    const response = await fetch(input.url, {
      method: input.method ?? "GET",
      ...(input.headers === undefined ? {} : { headers: input.headers }),
      ...(input.data === undefined
        ? {}
        : {
            body:
              typeof input.data === "string"
                ? input.data
                : input.data instanceof URLSearchParams
                  ? input.data
                  : JSON.stringify(input.data),
          }),
    });
    const text = await response.text();
    if (response.ok) {
      input.success?.(text, "success", response);
      return text;
    }
    input.error?.(response, "error", text);
    throw new Error(text || `ajax request failed with status ${String(response.status)}`);
  };

  return {
    ...globals,
    navigator: {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/537.36 Chrome/133.0.0.0 Safari/537.36",
      language: "en-US",
      languages: ["en-US", "en"],
      platform: "MacIntel",
      cookieEnabled: true,
      maxTouchPoints: 0,
    },
    location: {
      href: pageUrl.href,
      origin: pageUrl.origin,
      protocol: pageUrl.protocol,
      host: pageUrl.host,
      hostname: pageUrl.hostname,
      pathname: pageUrl.pathname,
      search: pageUrl.search,
      hash: pageUrl.hash,
      assign(value: string) {
        void value;
      },
      replace(value: string) {
        void value;
      },
      reload() {
        return undefined;
      },
    },
    performance: {
      now: () => options.clock.performanceNow(),
    },
    $,
    jQuery: $,
  };
}
