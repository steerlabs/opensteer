export interface BrowserCapabilities {
  readonly executor: {
    readonly sessionLifecycle: boolean;
    readonly pageLifecycle: boolean;
    readonly navigation: boolean;
    readonly pointerInput: boolean;
    readonly keyboardInput: boolean;
    readonly touchInput: boolean;
    readonly screenshots: boolean;
    readonly executionControl: {
      readonly pause: boolean;
      readonly resume: boolean;
      readonly freeze: boolean;
    };
  };
  readonly inspector: {
    readonly pageEnumeration: boolean;
    readonly frameEnumeration: boolean;
    readonly html: boolean;
    readonly domSnapshot: boolean;
    readonly visualStability: boolean;
    readonly text: boolean;
    readonly attributes: boolean;
    readonly hitTest: boolean;
    readonly viewportMetrics: boolean;
    readonly network: boolean;
    readonly networkBodies: boolean;
    readonly cookies: boolean;
    readonly localStorage: boolean;
    readonly sessionStorage: boolean;
    readonly indexedDb: boolean;
  };
  readonly transport: {
    readonly sessionHttp: boolean;
  };
  readonly instrumentation: {
    readonly initScripts: boolean;
    readonly routing: boolean;
  };
  readonly events: {
    readonly pageLifecycle: boolean;
    readonly dialog: boolean;
    readonly download: boolean;
    readonly chooser: boolean;
    readonly worker: boolean;
    readonly console: boolean;
    readonly pageError: boolean;
    readonly websocket: boolean;
    readonly eventStream: boolean;
    readonly executionState: boolean;
  };
}

export type BrowserCapabilityPath =
  | "executor.sessionLifecycle"
  | "executor.pageLifecycle"
  | "executor.navigation"
  | "executor.pointerInput"
  | "executor.keyboardInput"
  | "executor.touchInput"
  | "executor.screenshots"
  | "executor.executionControl.pause"
  | "executor.executionControl.resume"
  | "executor.executionControl.freeze"
  | "inspector.pageEnumeration"
  | "inspector.frameEnumeration"
  | "inspector.html"
  | "inspector.domSnapshot"
  | "inspector.visualStability"
  | "inspector.text"
  | "inspector.attributes"
  | "inspector.hitTest"
  | "inspector.viewportMetrics"
  | "inspector.network"
  | "inspector.networkBodies"
  | "inspector.cookies"
  | "inspector.localStorage"
  | "inspector.sessionStorage"
  | "inspector.indexedDb"
  | "transport.sessionHttp"
  | "instrumentation.initScripts"
  | "instrumentation.routing"
  | "events.pageLifecycle"
  | "events.dialog"
  | "events.download"
  | "events.chooser"
  | "events.worker"
  | "events.console"
  | "events.pageError"
  | "events.websocket"
  | "events.eventStream"
  | "events.executionState";

export type PartialBrowserCapabilities = {
  readonly [K in keyof BrowserCapabilities]?: BrowserCapabilities[K] extends object
    ? {
        readonly [Inner in keyof BrowserCapabilities[K]]?: BrowserCapabilities[K][Inner] extends object
          ? {
              readonly [Leaf in keyof BrowserCapabilities[K][Inner]]?: BrowserCapabilities[K][Inner][Leaf];
            }
          : BrowserCapabilities[K][Inner];
      }
    : BrowserCapabilities[K];
};

export function noBrowserCapabilities(): BrowserCapabilities {
  return {
    executor: {
      sessionLifecycle: false,
      pageLifecycle: false,
      navigation: false,
      pointerInput: false,
      keyboardInput: false,
      touchInput: false,
      screenshots: false,
      executionControl: {
        pause: false,
        resume: false,
        freeze: false,
      },
    },
    inspector: {
      pageEnumeration: false,
      frameEnumeration: false,
      html: false,
      domSnapshot: false,
      visualStability: false,
      text: false,
      attributes: false,
      hitTest: false,
      viewportMetrics: false,
      network: false,
      networkBodies: false,
      cookies: false,
      localStorage: false,
      sessionStorage: false,
      indexedDb: false,
    },
    transport: {
      sessionHttp: false,
    },
    instrumentation: {
      initScripts: false,
      routing: false,
    },
    events: {
      pageLifecycle: false,
      dialog: false,
      download: false,
      chooser: false,
      worker: false,
      console: false,
      pageError: false,
      websocket: false,
      eventStream: false,
      executionState: false,
    },
  };
}

export function allBrowserCapabilities(): BrowserCapabilities {
  return mergeBrowserCapabilities(noBrowserCapabilities(), {
    executor: {
      sessionLifecycle: true,
      pageLifecycle: true,
      navigation: true,
      pointerInput: true,
      keyboardInput: true,
      touchInput: true,
      screenshots: true,
      executionControl: {
        pause: true,
        resume: true,
        freeze: true,
      },
    },
    inspector: {
      pageEnumeration: true,
      frameEnumeration: true,
      html: true,
      domSnapshot: true,
      visualStability: true,
      text: true,
      attributes: true,
      hitTest: true,
      viewportMetrics: true,
      network: true,
      networkBodies: true,
      cookies: true,
      localStorage: true,
      sessionStorage: true,
      indexedDb: true,
    },
    transport: {
      sessionHttp: true,
    },
    instrumentation: {
      initScripts: true,
      routing: true,
    },
    events: {
      pageLifecycle: true,
      dialog: true,
      download: true,
      chooser: true,
      worker: true,
      console: true,
      pageError: true,
      websocket: true,
      eventStream: true,
      executionState: true,
    },
  });
}

export function mergeBrowserCapabilities(
  base: BrowserCapabilities,
  override: PartialBrowserCapabilities,
): BrowserCapabilities {
  return {
    executor: {
      ...base.executor,
      ...override.executor,
      executionControl: {
        ...base.executor.executionControl,
        ...override.executor?.executionControl,
      },
    },
    inspector: {
      ...base.inspector,
      ...override.inspector,
    },
    transport: {
      ...base.transport,
      ...override.transport,
    },
    instrumentation: {
      ...base.instrumentation,
      ...override.instrumentation,
    },
    events: {
      ...base.events,
      ...override.events,
    },
  };
}

export function hasCapability(
  capabilities: BrowserCapabilities,
  path: BrowserCapabilityPath,
): boolean {
  switch (path) {
    case "executor.sessionLifecycle":
      return capabilities.executor.sessionLifecycle;
    case "executor.pageLifecycle":
      return capabilities.executor.pageLifecycle;
    case "executor.navigation":
      return capabilities.executor.navigation;
    case "executor.pointerInput":
      return capabilities.executor.pointerInput;
    case "executor.keyboardInput":
      return capabilities.executor.keyboardInput;
    case "executor.touchInput":
      return capabilities.executor.touchInput;
    case "executor.screenshots":
      return capabilities.executor.screenshots;
    case "executor.executionControl.pause":
      return capabilities.executor.executionControl.pause;
    case "executor.executionControl.resume":
      return capabilities.executor.executionControl.resume;
    case "executor.executionControl.freeze":
      return capabilities.executor.executionControl.freeze;
    case "inspector.pageEnumeration":
      return capabilities.inspector.pageEnumeration;
    case "inspector.frameEnumeration":
      return capabilities.inspector.frameEnumeration;
    case "inspector.html":
      return capabilities.inspector.html;
    case "inspector.domSnapshot":
      return capabilities.inspector.domSnapshot;
    case "inspector.visualStability":
      return capabilities.inspector.visualStability;
    case "inspector.text":
      return capabilities.inspector.text;
    case "inspector.attributes":
      return capabilities.inspector.attributes;
    case "inspector.hitTest":
      return capabilities.inspector.hitTest;
    case "inspector.viewportMetrics":
      return capabilities.inspector.viewportMetrics;
    case "inspector.network":
      return capabilities.inspector.network;
    case "inspector.networkBodies":
      return capabilities.inspector.networkBodies;
    case "inspector.cookies":
      return capabilities.inspector.cookies;
    case "inspector.localStorage":
      return capabilities.inspector.localStorage;
    case "inspector.sessionStorage":
      return capabilities.inspector.sessionStorage;
    case "inspector.indexedDb":
      return capabilities.inspector.indexedDb;
    case "transport.sessionHttp":
      return capabilities.transport.sessionHttp;
    case "instrumentation.initScripts":
      return capabilities.instrumentation.initScripts;
    case "instrumentation.routing":
      return capabilities.instrumentation.routing;
    case "events.pageLifecycle":
      return capabilities.events.pageLifecycle;
    case "events.dialog":
      return capabilities.events.dialog;
    case "events.download":
      return capabilities.events.download;
    case "events.chooser":
      return capabilities.events.chooser;
    case "events.worker":
      return capabilities.events.worker;
    case "events.console":
      return capabilities.events.console;
    case "events.pageError":
      return capabilities.events.pageError;
    case "events.websocket":
      return capabilities.events.websocket;
    case "events.eventStream":
      return capabilities.events.eventStream;
    case "events.executionState":
      return capabilities.events.executionState;
  }
}
