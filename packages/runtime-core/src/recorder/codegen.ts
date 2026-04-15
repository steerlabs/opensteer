import type {
  CloudReplayTarget,
  CodegenOptions,
  LocalReplayTarget,
  RecordedAction,
  RecorderInitialPageState,
  ReplayTarget,
} from "./types.js";

const DISPATCH_KEY_SCRIPT = String.raw`(key) => {
  const target = document.activeElement;
  if (!(target instanceof Element)) {
    throw new Error("No active element is available for key replay.");
  }
  const normalizedKey = String(key);
  const eventInit = {
    key: normalizedKey,
    code: normalizedKey,
    bubbles: true,
    cancelable: true,
  };
  target.dispatchEvent(new KeyboardEvent("keydown", eventInit));
  target.dispatchEvent(new KeyboardEvent("keyup", eventInit));
}`;

const SELECT_OPTION_SCRIPT = String.raw`(selector, value) => {
  const target = document.querySelector(String(selector));
  if (!(target instanceof HTMLSelectElement)) {
    throw new Error("Unable to find a <select> element for option replay.");
  }
  target.value = String(value);
  target.dispatchEvent(new Event("input", { bubbles: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
}`;

const HISTORY_ACTION_SCRIPT = String.raw`(action) => {
  const normalized = String(action);
  if (normalized === "back") {
    history.back();
    return;
  }
  if (normalized === "forward") {
    history.forward();
    return;
  }
  if (normalized === "reload") {
    location.reload();
    return;
  }
  throw new Error("Unsupported history action: " + normalized);
}`;

const WINDOW_SCROLL_SCRIPT = String.raw`(deltaX, deltaY) => {
  window.scrollBy(Number(deltaX), Number(deltaY));
}`;

export function generateReplayScript(options: CodegenOptions): string {
  const replayTarget = resolveReplayTarget(options);
  const initialPages = orderInitialPages(resolveInitialPages(options));
  const activeInitialPageId = resolveActiveInitialPageId(options, initialPages);
  const initialPageId = initialPages[0]?.pageId ?? "page0";
  const lines: string[] = [
    `import { Opensteer } from "opensteer";`,
    ``,
    ...renderOpensteerBootstrap(replayTarget),
    ``,
    `await opensteer.open(${JSON.stringify(initialPages[0]?.initialUrl ?? "")});`,
    `const ${initialPageId} = (await opensteer.listPages()).activePageRef;`,
    `if (!${initialPageId}) {`,
    `  throw new Error("Opensteer did not report an active page after open().");`,
    `}`,
    `let activePageRef: string | undefined = ${initialPageId};`,
    ``,
    `async function ensureActive(pageRef: string): Promise<void> {`,
    `  if (activePageRef === pageRef) {`,
    `    return;`,
    `  }`,
    `  await opensteer.activatePage({ pageRef });`,
    `  activePageRef = pageRef;`,
    `}`,
    ``,
    `async function dispatchKey(pageRef: string, key: string): Promise<void> {`,
    `  await ensureActive(pageRef);`,
    `  await opensteer.evaluate({`,
    `    pageRef,`,
    `    script: ${JSON.stringify(DISPATCH_KEY_SCRIPT)},`,
    `    args: [key],`,
    `  });`,
    `}`,
    ``,
    `async function selectOption(pageRef: string, selector: string, value: string): Promise<void> {`,
    `  await ensureActive(pageRef);`,
    `  await opensteer.evaluate({`,
    `    pageRef,`,
    `    script: ${JSON.stringify(SELECT_OPTION_SCRIPT)},`,
    `    args: [selector, value],`,
    `  });`,
    `}`,
    ``,
    `async function runHistoryAction(pageRef: string, action: "back" | "forward" | "reload"): Promise<void> {`,
    `  await ensureActive(pageRef);`,
    `  await opensteer.evaluate({`,
    `    pageRef,`,
    `    script: ${JSON.stringify(HISTORY_ACTION_SCRIPT)},`,
    `    args: [action],`,
    `  });`,
    `}`,
    ``,
    `try {`,
  ];

  const declaredPages = new Set<string>([initialPageId]);
  for (const page of initialPages.slice(1)) {
    const openerPageId =
      page.openerPageId !== undefined && declaredPages.has(page.openerPageId)
        ? page.openerPageId
        : undefined;
    lines.push(
      `  const ${page.pageId} = (await opensteer.newPage(${renderNewPageInput(openerPageId, page.initialUrl)})).pageRef;`,
    );
    lines.push(`  activePageRef = ${page.pageId};`);
    declaredPages.add(page.pageId);
  }
  if (activeInitialPageId !== undefined && activeInitialPageId !== initialPageId) {
    lines.push(`  await ensureActive(${activeInitialPageId});`);
  }
  for (let index = 0; index < options.actions.length; index += 1) {
    const action = options.actions[index]!;
    const pageVar = action.pageId;

    if (action.kind === "type") {
      const nextAction = options.actions[index + 1];
      const mergedPressEnter =
        nextAction?.kind === "keypress" &&
        nextAction.pageId === action.pageId &&
        nextAction.selector === action.selector &&
        nextAction.detail.kind === "keypress" &&
        nextAction.detail.key === "Enter" &&
        nextAction.detail.modifiers.length === 0;

      lines.push(`  await ensureActive(${pageVar});`);
      lines.push(
        `  await opensteer.input({ selector: ${JSON.stringify(requireSelector(action))}, text: ${JSON.stringify(action.detail.text)}${mergedPressEnter ? `, pressEnter: true` : ``} });`,
      );
      if (mergedPressEnter) {
        index += 1;
      }
      continue;
    }

    if (
      action.kind === "switch-tab" &&
      options.actions[index - 1]?.kind === "new-tab" &&
      options.actions[index - 1]?.pageId === action.pageId
    ) {
      continue;
    }

    switch (action.kind) {
      case "navigate":
        lines.push(`  await ensureActive(${pageVar});`);
        lines.push(`  await opensteer.goto(${JSON.stringify(action.detail.url)});`);
        break;
      case "click":
        lines.push(`  await ensureActive(${pageVar});`);
        lines.push(
          `  await opensteer.click({ selector: ${JSON.stringify(requireSelector(action))} });`,
        );
        break;
      case "dblclick":
        lines.push(`  await ensureActive(${pageVar});`);
        lines.push(
          `  await opensteer.click({ selector: ${JSON.stringify(requireSelector(action))}, clickCount: 2 });`,
        );
        break;
      case "keypress":
        lines.push(`  await dispatchKey(${pageVar}, ${JSON.stringify(action.detail.key)});`);
        break;
      case "scroll": {
        const { direction, amount, isWindowScroll } = normalizeScrollAction(action);
        lines.push(`  await ensureActive(${pageVar});`);
        if (isWindowScroll) {
          lines.push(`  await opensteer.evaluate({`);
          lines.push(`    pageRef: ${pageVar},`);
          lines.push(`    script: ${JSON.stringify(WINDOW_SCROLL_SCRIPT)},`);
          lines.push(
            `    args: [${String(action.detail.deltaX)}, ${String(action.detail.deltaY)}],`,
          );
          lines.push(`  });`);
        } else {
          lines.push(
            `  await opensteer.scroll({ selector: ${JSON.stringify(requireSelector(action))}, direction: ${JSON.stringify(direction)}, amount: ${String(amount)} });`,
          );
        }
        break;
      }
      case "select-option":
        lines.push(
          `  await selectOption(${pageVar}, ${JSON.stringify(requireSelector(action))}, ${JSON.stringify(action.detail.value)});`,
        );
        break;
      case "new-tab": {
        const openerPageVar = action.detail.openerPageId;
        const shouldUseWaitForPage = shouldUsePopupWait(options.actions, index, openerPageVar);
        const creationLine =
          shouldUseWaitForPage && openerPageVar !== undefined
            ? `  const ${pageVar} = (await opensteer.waitForPage({ openerPageRef: ${openerPageVar}, timeoutMs: 30_000 })).pageRef;`
            : `  const ${pageVar} = (await opensteer.newPage(${renderNewPageInput(action.detail.openerPageId, action.detail.initialUrl)})).pageRef;`;
        lines.push(creationLine);
        lines.push(`  activePageRef = ${pageVar};`);
        declaredPages.add(pageVar);
        break;
      }
      case "close-tab":
        lines.push(`  await opensteer.closePage({ pageRef: ${pageVar} });`);
        lines.push(`  if (activePageRef === ${pageVar}) {`);
        lines.push(`    activePageRef = undefined;`);
        lines.push(`  }`);
        break;
      case "switch-tab":
        lines.push(`  await ensureActive(${pageVar});`);
        break;
      case "go-back":
        lines.push(`  await runHistoryAction(${pageVar}, "back");`);
        break;
      case "go-forward":
        lines.push(`  await runHistoryAction(${pageVar}, "forward");`);
        break;
      case "reload":
        lines.push(`  await runHistoryAction(${pageVar}, "reload");`);
        break;
    }
  }

  lines.push(`} finally {`);
  lines.push(`  await opensteer.close();`);
  lines.push(`}`);
  lines.push(``);

  return `${lines.join("\n")}\n`;
}

function resolveReplayTarget(options: CodegenOptions): ReplayTarget {
  if (options.replayTarget !== undefined) {
    return options.replayTarget;
  }
  if (options.workspace !== undefined) {
    return {
      kind: "local",
      workspace: options.workspace,
    } satisfies LocalReplayTarget;
  }
  throw new Error("Replay codegen requires either replayTarget or workspace.");
}

function resolveInitialPages(options: CodegenOptions): readonly RecorderInitialPageState[] {
  if (options.initialPages !== undefined && options.initialPages.length > 0) {
    const unique = new Set<string>();
    return options.initialPages.map((page) => {
      if (unique.has(page.pageId)) {
        throw new Error(`Duplicate initial page id "${page.pageId}" in recording bootstrap.`);
      }
      unique.add(page.pageId);
      return page;
    });
  }
  const startUrl = options.startUrl;
  if (startUrl === undefined) {
    throw new Error("Replay codegen requires startUrl when initialPages is not provided.");
  }
  return [
    {
      pageId: "page0",
      initialUrl: startUrl,
    },
  ];
}

function resolveActiveInitialPageId(
  options: CodegenOptions,
  initialPages: readonly RecorderInitialPageState[],
): string | undefined {
  if (options.activePageId !== undefined) {
    return options.activePageId;
  }
  return initialPages[0]?.pageId;
}

function renderOpensteerBootstrap(replayTarget: ReplayTarget): string[] {
  if (replayTarget.kind === "local") {
    return [
      `const opensteer = new Opensteer({`,
      `  workspace: ${JSON.stringify(replayTarget.workspace)},`,
      `  browser: "persistent",`,
      `});`,
    ];
  }

  return [
    renderRequireEnvHelper(replayTarget),
    ``,
    `const opensteer = new Opensteer({`,
    `  provider: {`,
    `    mode: "cloud",`,
    `    baseUrl: requireEnv(${JSON.stringify(replayTarget.baseUrlEnvVar ?? "OPENSTEER_BASE_URL")}),`,
    `    apiKey: requireEnv(${JSON.stringify(replayTarget.apiKeyEnvVar ?? "OPENSTEER_API_KEY")}),`,
    ...renderCloudBrowserProfile(replayTarget),
    `  },`,
    `});`,
  ];
}

function renderRequireEnvHelper(replayTarget: CloudReplayTarget): string {
  const baseUrlEnvVar = replayTarget.baseUrlEnvVar ?? "OPENSTEER_BASE_URL";
  const apiKeyEnvVar = replayTarget.apiKeyEnvVar ?? "OPENSTEER_API_KEY";
  return [
    `function requireEnv(name: string): string {`,
    `  const value = process.env[name];`,
    `  if (typeof value === "string" && value.trim().length > 0) {`,
    `    return value;`,
    `  }`,
    `  throw new Error(\`Missing environment variable \${name}. Set ${baseUrlEnvVar} and ${apiKeyEnvVar} before replaying this recording.\`);`,
    `}`,
  ].join("\n");
}

function renderCloudBrowserProfile(replayTarget: CloudReplayTarget): string[] {
  if (replayTarget.browserProfileId === undefined) {
    return [];
  }
  return [
    `    browserProfile: {`,
    `      profileId: ${JSON.stringify(replayTarget.browserProfileId)},`,
    ...(replayTarget.reuseBrowserProfileIfActive ? [`      reuseIfActive: true,`] : []),
    `    },`,
  ];
}

function orderInitialPages(
  initialPages: readonly RecorderInitialPageState[],
): RecorderInitialPageState[] {
  const ordered: RecorderInitialPageState[] = [];
  const declared = new Set<string>();
  const remaining = [...initialPages];

  while (remaining.length > 0) {
    let advanced = false;
    for (let index = 0; index < remaining.length; index += 1) {
      const page = remaining[index]!;
      if (page.openerPageId !== undefined && !declared.has(page.openerPageId)) {
        continue;
      }
      ordered.push(page);
      declared.add(page.pageId);
      remaining.splice(index, 1);
      advanced = true;
      break;
    }

    if (!advanced) {
      ordered.push(...remaining.splice(0, remaining.length));
    }
  }

  return ordered;
}

function requireSelector(action: RecordedAction): string {
  if (action.selector === undefined) {
    throw new Error(`Action "${action.kind}" on ${action.pageId} is missing a selector.`);
  }
  return action.selector;
}

function normalizeScrollAction(action: Extract<RecordedAction, { readonly kind: "scroll" }>): {
  readonly direction: "up" | "down" | "left" | "right";
  readonly amount: number;
  readonly isWindowScroll: boolean;
} {
  const horizontal = Math.abs(action.detail.deltaX);
  const vertical = Math.abs(action.detail.deltaY);
  if (vertical >= horizontal) {
    return {
      direction: action.detail.deltaY < 0 ? "up" : "down",
      amount: Math.max(1, Math.round(vertical)),
      isWindowScroll: action.selector === undefined,
    };
  }
  return {
    direction: action.detail.deltaX < 0 ? "left" : "right",
    amount: Math.max(1, Math.round(horizontal)),
    isWindowScroll: action.selector === undefined,
  };
}

function shouldUsePopupWait(
  actions: readonly RecordedAction[],
  newTabIndex: number,
  openerPageId: string | undefined,
): boolean {
  if (openerPageId === undefined || newTabIndex === 0) {
    return false;
  }
  const previousAction = actions[newTabIndex - 1];
  if (previousAction === undefined || previousAction.pageId !== openerPageId) {
    return false;
  }
  return (
    previousAction.kind === "click" ||
    previousAction.kind === "dblclick" ||
    previousAction.kind === "keypress"
  );
}

function renderNewPageInput(openerPageId: string | undefined, initialUrl: string): string {
  const argumentsList: string[] = [];
  if (openerPageId !== undefined) {
    argumentsList.push(`openerPageRef: ${openerPageId}`);
  }
  if (initialUrl.length > 0 && initialUrl !== "about:blank") {
    argumentsList.push(`url: ${JSON.stringify(initialUrl)}`);
  }
  if (argumentsList.length === 0) {
    return `{}`;
  }
  return `{ ${argumentsList.join(", ")} }`;
}
