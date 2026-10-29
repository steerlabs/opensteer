import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { aroundEach } from "vitest";
import { delay } from "@opensteer/shared/delay";
import type {
  BrowserLaunchRequest,
  LaunchedBrowser,
  SurfaceLedger,
} from "@opensteer/browser-runtime-core";
import type { FakeSink } from "@opensteer/browser-runtime-core/test-support";
import { PlaywrightChromiumLauncher } from "./playwright-launcher.js";

interface BrowserTestScope {
  readonly signal: AbortSignal;
  readonly browsers: Set<LaunchedBrowser>;
  readonly cleanup: Array<() => Promise<void>>;
  closed: boolean;
  stopping: Promise<void> | null;
}

// Async continuations of a timed-out journey must retain that journey's
// signal and resource list even after Vitest starts the next test.
const scopes = new AsyncLocalStorage<BrowserTestScope>();

aroundEach(async (runTest, context) => {
  const scope: BrowserTestScope = {
    signal: context.signal,
    browsers: new Set(),
    cleanup: [],
    closed: false,
    stopping: null,
  };
  const stop = () => {
    scope.stopping ??= Promise.allSettled(
      [...scope.browsers].map((browser) => browser.close()),
    ).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Test browsers did not close.");
    });
    return scope.stopping;
  };
  const abort = () => {
    void stop().catch(() => undefined);
  };
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    await scopes.run(scope, async () => {
      const failures: unknown[] = [];
      try {
        await runTest();
      } catch (error) {
        failures.push(error);
      }
      scope.closed = true;
      for (const dispose of scope.cleanup.reverse()) {
        try {
          await dispose();
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        await stop();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) throw new AggregateError(failures, "Browser journey cleanup failed.");
    });
  } finally {
    context.signal.removeEventListener("abort", abort);
  }
});

function currentScope(): BrowserTestScope {
  const scope = scopes.getStore();
  if (!scope) throw new Error("Browser journey work was started outside its test scope.");
  return scope;
}

export function browserTestSignal(): AbortSignal {
  return currentScope().signal;
}

export const cleanup = {
  push(dispose: () => Promise<void>): void {
    const scope = currentScope();
    if (scope.closed || scope.signal.aborted) {
      void dispose().catch(() => undefined);
      scope.signal.throwIfAborted();
      throw new Error("Browser journey has ended.");
    }
    scope.cleanup.push(dispose);
  },
};

export class TestChromiumLauncher extends PlaywrightChromiumLauncher {
  override async launch(request: BrowserLaunchRequest): Promise<LaunchedBrowser> {
    const scope = currentScope();
    scope.signal.throwIfAborted();
    const browser = await super.launch(request, scope.signal);
    if (scope.closed || scope.signal.aborted) {
      await browser.close();
      scope.signal.throwIfAborted();
      throw new Error("Browser journey ended while Chromium was launching.");
    }
    scope.browsers.add(browser);
    return browser;
  }
}

export function withBrowserTestSignal<T>(
  operation: Promise<T>,
  signal = browserTestSignal(),
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const finish = () => signal.removeEventListener("abort", abort);
    operation.then(
      (result) => {
        finish();
        resolve(result);
      },
      (error: unknown) => {
        finish();
        reject(error);
      },
    );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForBrowserState(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const signal = browserTestSignal();
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal.throwIfAborted();
    if (await withBrowserTestSignal(Promise.resolve(predicate()), signal)) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for real Chromium state.");
    await delay(25, signal);
  }
}

export function waitForLedgerState(ledger: SurfaceLedger, predicate: () => boolean): Promise<void> {
  return waitForStateEvent((check) => ledger.subscribe(check), predicate);
}

export function waitForBrowserMessages(sink: FakeSink, predicate: () => boolean): Promise<void> {
  return waitForStateEvent((check) => {
    const previous = sink.sendServerImplementation;
    sink.sendServerImplementation = async (message) => {
      await previous?.(message);
      check();
    };
    return () => {
      sink.sendServerImplementation = previous;
    };
  }, predicate);
}

function waitForStateEvent(
  subscribe: (check: () => void) => () => void,
  predicate: () => boolean,
): Promise<void> {
  const signal = browserTestSignal();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unsubscribe();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    const check = () => {
      if (settled || !predicate()) return;
      finish();
      resolve();
    };
    const unsubscribe = subscribe(check);
    if (signal.aborted) abort();
    else {
      signal.addEventListener("abort", abort, { once: true });
      check();
    }
  });
}

export function findChromium(): string {
  const executable = chromium.executablePath();
  if (!existsSync(executable)) {
    throw new Error(
      `Pinned Chromium is required at ${executable}. Run: pnpm exec playwright-core install chromium`,
    );
  }
  return executable;
}
