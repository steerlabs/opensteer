import type { OpensteerConnectConfig } from "./config.js";
import type { OpensteerEngineFactory } from "../sdk/runtime.js";

interface ConnectedEngineDependencies {
  readonly importPlaywrightEngineModule?: () => Promise<typeof import("@opensteer/engine-playwright")>;
}

export function createConnectedOpensteerEngineFactory(
  config: OpensteerConnectConfig,
  dependencies: ConnectedEngineDependencies = {},
): OpensteerEngineFactory {
  const importPlaywrightEngineModule =
    dependencies.importPlaywrightEngineModule ?? (() => import("@opensteer/engine-playwright"));
  let browserPromise:
    | Promise<
        Awaited<
          ReturnType<(typeof import("@opensteer/engine-playwright"))["connectPlaywrightChromiumBrowser"]>
        >
      >
    | undefined;

  return async (options) => {
    if (options.browser !== undefined) {
      throw new Error(
        "Connect mode does not support browser launch options. Provision the remote browser before connecting.",
      );
    }

    const playwrightEngineModule = await importPlaywrightEngineModule();
    browserPromise ??= playwrightEngineModule.connectPlaywrightChromiumBrowser({
      url: config.url,
      ...(config.headers === undefined ? {} : { headers: config.headers }),
    });
    const browser = await browserPromise;
    return playwrightEngineModule.createPlaywrightBrowserCoreEngine({
      browser,
      closeBrowserOnDispose: false,
      ...(options.context === undefined ? {} : { context: options.context }),
    });
  };
}
