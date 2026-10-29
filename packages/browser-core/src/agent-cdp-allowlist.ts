/**
 * Everything an agent may send to a page and receive from it, exactly. Each
 * method's parameters and each event were reviewed against the CDP spec of
 * the devtools-protocol release named here, which the browser runtime pins
 * (`apps/browser-runtime/src/browser/agent-cdp-allowlist.test.ts` holds the
 * two together and checks every entry against that spec). Anything Chromium
 * adds later, whether a method, parameter, nested field, enum value or event,
 * stays refused until it is reviewed here; a newer engine can only narrow
 * what agents get.
 */
export const reviewedDevtoolsProtocol = "0.0.1676105";

export type AgentCdpValue =
  | { readonly kind: "any" | "boolean" | "integer" | "number" | "record" | "string" }
  | { readonly kind: "array"; readonly items: AgentCdpValue }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  | { readonly kind: "object"; readonly fields: AgentCdpFields };

/** A field the agent may set; `optional` fields may be left out. */
export type AgentCdpField = AgentCdpValue & { readonly optional?: true };

export type AgentCdpFields = Readonly<Record<string, AgentCdpField>>;

const any = { kind: "any" } as const;
const boolean = { kind: "boolean" } as const;
const integer = { kind: "integer" } as const;
const number = { kind: "number" } as const;
/** An object whose keys the spec leaves open, such as serialization hints. */
const record = { kind: "record" } as const;
const string = { kind: "string" } as const;
const arrayOf = (items: AgentCdpValue) => ({ items, kind: "array" }) as const;
const oneOf = (...values: string[]) => ({ kind: "enum", values }) as const;
const object = (fields: AgentCdpFields) => ({ fields, kind: "object" }) as const;
const optional = <Value extends AgentCdpValue>(value: Value) =>
  ({ ...value, optional: true }) as const;

// Spec types that allowed parameters refer to, as the shipped spec defines them.
const backendNodeId = integer;
const nodeId = integer;
const remoteObjectId = string;
const viewport = object({ height: number, scale: number, width: number, x: number, y: number });
const rect = object({ height: number, width: number, x: number, y: number });
const serializationOptions = object({
  additionalParameters: optional(record),
  maxDepth: optional(integer),
  serialization: oneOf("deep", "json", "idOnly"),
});
const callArgument = object({
  objectId: optional(remoteObjectId),
  unserializableValue: optional(string),
  value: optional(any),
});
const touchPoint = object({
  force: optional(number),
  id: optional(number),
  radiusX: optional(number),
  radiusY: optional(number),
  rotationAngle: optional(number),
  tangentialPressure: optional(number),
  tiltX: optional(number),
  tiltY: optional(number),
  twist: optional(integer),
  x: number,
  y: number,
});
const dragData = object({
  dragOperationsMask: integer,
  files: optional(arrayOf(string)),
  items: arrayOf(
    object({
      baseURL: optional(string),
      data: string,
      mimeType: string,
      title: optional(string),
    }),
  ),
});
const mouseButton = oneOf("none", "left", "middle", "right", "back", "forward");
const nodeTarget = {
  backendNodeId: optional(backendNodeId),
  nodeId: optional(nodeId),
  objectId: optional(remoteObjectId),
} as const;

/**
 * Each method's exact parameters. Left out on purpose, and so refused:
 * parameters that select an execution context (`contextId`,
 * `executionContextId`, `uniqueContextId`), which would leave frames' main
 * worlds; `Page.navigate` `referrer` and `referrerPolicy`, which write a
 * request header no page script can set; `Page.reload`
 * `scriptToEvaluateOnLoad`, which runs outside the loaded page; and the
 * device-metrics `scale` and `viewport`, which resize rendering past the
 * bounded browser frame. A parameter the spec marks optional may be required
 * here, never the reverse.
 */
const methods: Readonly<Record<string, AgentCdpFields>> = {
  "Page.enable": { enableFileChooserOpenedEvent: optional(boolean) },
  "Page.disable": {},
  "Page.navigate": {
    frameId: optional(string),
    transitionType: optional(
      oneOf(
        "link",
        "typed",
        "address_bar",
        "auto_bookmark",
        "auto_subframe",
        "manual_subframe",
        "generated",
        "auto_toplevel",
        "form_submit",
        "reload",
        "keyword",
        "keyword_generated",
        "other",
      ),
    ),
    url: string,
  },
  "Page.reload": { ignoreCache: optional(boolean), loaderId: optional(string) },
  "Page.stopLoading": {},
  "Page.getNavigationHistory": {},
  "Page.navigateToHistoryEntry": { entryId: integer },
  "Page.getFrameTree": {},
  "Page.getLayoutMetrics": {},
  "Page.captureScreenshot": {
    captureBeyondViewport: optional(boolean),
    clip: optional(viewport),
    format: optional(oneOf("jpeg", "png", "webp")),
    fromSurface: optional(boolean),
    optimizeForSpeed: optional(boolean),
    quality: optional(integer),
  },
  "Page.printToPDF": {
    displayHeaderFooter: optional(boolean),
    footerTemplate: optional(string),
    generateDocumentOutline: optional(boolean),
    generateTaggedPDF: optional(boolean),
    headerTemplate: optional(string),
    landscape: optional(boolean),
    marginBottom: optional(number),
    marginLeft: optional(number),
    marginRight: optional(number),
    marginTop: optional(number),
    pageRanges: optional(string),
    paperHeight: optional(number),
    paperWidth: optional(number),
    preferCSSPageSize: optional(boolean),
    printBackground: optional(boolean),
    scale: optional(number),
    // Inline only: an IO stream would need the IO domain.
    transferMode: optional(oneOf("ReturnAsBase64")),
  },
  "Page.handleJavaScriptDialog": { accept: boolean, promptText: optional(string) },
  "Page.setLifecycleEventsEnabled": { enabled: boolean },
  "Page.bringToFront": {},
  "Page.setInterceptFileChooserDialog": { cancel: optional(boolean), enabled: boolean },
  "Page.startScreencast": {
    everyNthFrame: optional(integer),
    format: optional(oneOf("jpeg", "png")),
    maxHeight: optional(integer),
    maxWidth: optional(integer),
    quality: optional(integer),
  },
  "Page.screencastFrameAck": { sessionId: integer },
  "Page.stopScreencast": {},
  "Runtime.enable": {},
  "Runtime.disable": {},
  "Runtime.evaluate": {
    allowUnsafeEvalBlockedByCSP: optional(boolean),
    awaitPromise: optional(boolean),
    disableBreaks: optional(boolean),
    expression: string,
    generatePreview: optional(boolean),
    includeCommandLineAPI: optional(boolean),
    objectGroup: optional(string),
    replMode: optional(boolean),
    returnByValue: optional(boolean),
    serializationOptions: optional(serializationOptions),
    silent: optional(boolean),
    throwOnSideEffect: optional(boolean),
    timeout: optional(number),
    userGesture: optional(boolean),
  },
  "Runtime.callFunctionOn": {
    arguments: optional(arrayOf(callArgument)),
    awaitPromise: optional(boolean),
    functionDeclaration: string,
    generatePreview: optional(boolean),
    objectGroup: optional(string),
    // Without it Chromium would pick a context; the object names a main world.
    objectId: remoteObjectId,
    returnByValue: optional(boolean),
    serializationOptions: optional(serializationOptions),
    silent: optional(boolean),
    throwOnSideEffect: optional(boolean),
    userGesture: optional(boolean),
  },
  "Runtime.getProperties": {
    accessorPropertiesOnly: optional(boolean),
    generatePreview: optional(boolean),
    nonIndexedPropertiesOnly: optional(boolean),
    objectId: remoteObjectId,
    ownProperties: optional(boolean),
  },
  "Runtime.awaitPromise": {
    generatePreview: optional(boolean),
    promiseObjectId: remoteObjectId,
    returnByValue: optional(boolean),
  },
  "Runtime.releaseObject": { objectId: remoteObjectId },
  "Runtime.releaseObjectGroup": { objectGroup: string },
  "DOM.enable": { includeWhitespace: optional(oneOf("none", "all")) },
  "DOM.disable": {},
  "DOM.getDocument": { depth: optional(integer), pierce: optional(boolean) },
  "DOM.querySelector": { nodeId, selector: string },
  "DOM.querySelectorAll": { nodeId, selector: string },
  "DOM.describeNode": { ...nodeTarget, depth: optional(integer), pierce: optional(boolean) },
  "DOM.resolveNode": {
    backendNodeId: optional(backendNodeId),
    nodeId: optional(nodeId),
    objectGroup: optional(string),
  },
  "DOM.requestNode": { objectId: remoteObjectId },
  "DOM.getBoxModel": nodeTarget,
  "DOM.getContentQuads": nodeTarget,
  "DOM.getNodeForLocation": {
    ignorePointerEventsNone: optional(boolean),
    includeUserAgentShadowDOM: optional(boolean),
    x: integer,
    y: integer,
  },
  "DOM.getOuterHTML": { ...nodeTarget, includeShadowDOM: optional(boolean) },
  "DOM.getAttributes": { nodeId },
  "DOM.scrollIntoViewIfNeeded": { ...nodeTarget, rect: optional(rect) },
  "DOM.focus": nodeTarget,
  "DOM.setFileInputFiles": { ...nodeTarget, files: arrayOf(string) },
  "DOM.setAttributeValue": { name: string, nodeId, value: string },
  "DOM.removeAttribute": { name: string, nodeId },
  "DOM.setOuterHTML": { nodeId, outerHTML: string },
  "DOM.removeNode": { nodeId },
  "Input.dispatchMouseEvent": {
    button: optional(mouseButton),
    buttons: optional(integer),
    clickCount: optional(integer),
    deltaX: optional(number),
    deltaY: optional(number),
    force: optional(number),
    modifiers: optional(integer),
    pointerType: optional(oneOf("mouse", "pen")),
    tangentialPressure: optional(number),
    tiltX: optional(number),
    tiltY: optional(number),
    timestamp: optional(number),
    twist: optional(integer),
    type: oneOf("mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"),
    x: number,
    y: number,
  },
  "Input.dispatchKeyEvent": {
    autoRepeat: optional(boolean),
    code: optional(string),
    commands: optional(arrayOf(string)),
    isKeypad: optional(boolean),
    isSystemKey: optional(boolean),
    key: optional(string),
    keyIdentifier: optional(string),
    location: optional(integer),
    modifiers: optional(integer),
    // Legacy agents may send it; the router validates then discards it.
    nativeVirtualKeyCode: optional(integer),
    text: optional(string),
    timestamp: optional(number),
    type: oneOf("keyDown", "keyUp", "rawKeyDown", "char"),
    unmodifiedText: optional(string),
    windowsVirtualKeyCode: optional(integer),
  },
  "Input.insertText": { text: string },
  "Input.dispatchTouchEvent": {
    modifiers: optional(integer),
    timestamp: optional(number),
    touchPoints: arrayOf(touchPoint),
    type: oneOf("touchStart", "touchEnd", "touchMove", "touchCancel"),
  },
  "Input.dispatchDragEvent": {
    data: dragData,
    modifiers: optional(integer),
    type: oneOf("dragEnter", "dragOver", "drop", "dragCancel"),
    x: number,
    y: number,
  },
  "Emulation.setDeviceMetricsOverride": {
    deviceScaleFactor: number,
    dontSetVisibleSize: optional(boolean),
    height: integer,
    mobile: boolean,
    positionX: optional(integer),
    positionY: optional(integer),
    screenHeight: optional(integer),
    screenOrientation: optional(
      object({
        angle: integer,
        type: oneOf(
          "portraitPrimary",
          "portraitSecondary",
          "landscapePrimary",
          "landscapeSecondary",
        ),
      }),
    ),
    screenOrientationLockEmulation: optional(boolean),
    screenWidth: optional(integer),
    scrollbarType: optional(oneOf("overlay", "default")),
    width: integer,
  },
  "Emulation.clearDeviceMetricsOverride": {},
  "Emulation.setTouchEmulationEnabled": { enabled: boolean, maxTouchPoints: optional(integer) },
  "Emulation.setEmulatedMedia": {
    features: optional(arrayOf(object({ name: string, value: string }))),
    media: optional(string),
  },
  "Accessibility.enable": {},
  "Accessibility.disable": {},
  "Accessibility.getFullAXTree": { depth: optional(integer), frameId: optional(string) },
  "Accessibility.getPartialAXTree": { ...nodeTarget, fetchRelatives: optional(boolean) },
  "Accessibility.queryAXTree": {
    ...nodeTarget,
    accessibleName: optional(string),
    role: optional(string),
  },
  "DOMSnapshot.captureSnapshot": {
    computedStyles: arrayOf(string),
    includeBlendedBackgroundColors: optional(boolean),
    includeDOMRects: optional(boolean),
    includePaintOrder: optional(boolean),
    includeTextColorOpacities: optional(boolean),
  },
};

/**
 * Every event an agent may receive, each one something a frame's own scripts
 * could observe: DOM changes (as a MutationObserver sees them), navigation
 * and load progress, dialogs, file choosers and window.open calls the page
 * made, its main worlds' contexts, console output and exceptions, the
 * accessibility tree the allowed commands already return, and its own
 * screencast. Refused among the domains that have allowed commands: Page
 * downloads, interstitials, back/forward cache verdicts and compilation
 * caches; Runtime bindings and inspect requests; DOM adopted style sheet IDs,
 * ad-tagging verdicts, Shadow DOM v0 distribution and style engine flags;
 * Input drag interception; Inspector reload and worker notices; Emulation
 * virtual time and orientation locks.
 */
const events: readonly string[] = [
  "Page.domContentEventFired",
  "Page.loadEventFired",
  "Page.lifecycleEvent",
  "Page.frameAttached",
  "Page.frameDetached",
  "Page.frameSubtreeWillBeDetached",
  "Page.frameNavigated",
  "Page.documentOpened",
  "Page.frameResized",
  "Page.frameStartedNavigating",
  "Page.frameRequestedNavigation",
  "Page.frameScheduledNavigation",
  "Page.frameClearedScheduledNavigation",
  "Page.frameStartedLoading",
  "Page.frameStoppedLoading",
  "Page.navigatedWithinDocument",
  "Page.javascriptDialogOpening",
  "Page.javascriptDialogClosed",
  "Page.fileChooserOpened",
  "Page.windowOpen",
  "Page.screencastFrame",
  "Page.screencastVisibilityChanged",
  "Runtime.executionContextCreated",
  "Runtime.executionContextDestroyed",
  "Runtime.executionContextsCleared",
  "Runtime.consoleAPICalled",
  "Runtime.exceptionThrown",
  "Runtime.exceptionRevoked",
  "DOM.attributeModified",
  "DOM.attributeRemoved",
  "DOM.characterDataModified",
  "DOM.childNodeCountUpdated",
  "DOM.childNodeInserted",
  "DOM.childNodeRemoved",
  "DOM.documentUpdated",
  "DOM.inlineStyleInvalidated",
  "DOM.pseudoElementAdded",
  "DOM.pseudoElementRemoved",
  "DOM.scrollableFlagUpdated",
  "DOM.setChildNodes",
  "DOM.shadowRootPopped",
  "DOM.shadowRootPushed",
  "DOM.topLayerElementsUpdated",
  "Accessibility.loadComplete",
  "Accessibility.nodesUpdated",
  "Inspector.detached",
  "Inspector.targetCrashed",
];

export const agentCdpAllowlist: {
  readonly events: ReadonlySet<string>;
  readonly methods: ReadonlyMap<string, AgentCdpFields>;
  readonly protocolVersion: string;
} = {
  events: new Set(events),
  methods: new Map(Object.entries(methods)),
  protocolVersion: reviewedDevtoolsProtocol,
};
