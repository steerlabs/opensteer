import { SessionCdpRouter } from "@opensteer/browser-core";
import {
  browserHostMethods,
  BrowserSessionTabOpenCommandSchema,
  BrowserSurfaceIdSchema,
  type BrowserAttachTicketClaims,
  type BrowserClientMessage,
} from "@opensteer/protocol";
import { gate } from "@opensteer/shared/test-support/observation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HostRelayAuthenticator } from "../passkeys/host-relay.js";
import {
  PublicKeyCredentialRequestOptionsJSONSchema,
  serializeClientData,
} from "../passkeys/index.js";
import {
  FakeBrowserCdpBackend,
  FakeContext,
  FakePage,
  FakeSink,
  flushMicrotasks,
  jpeg,
  testSessionFilesRoot,
  validClaims,
  withoutTitleSamples,
} from "../test-support/fakes.js";
import { BrowserController } from "./controller.js";
import { HostSignIns, type HostLoginAuthorizeInput } from "./host-sign-ins.js";
import { SessionFiles } from "./session-files.js";
import { SurfaceLedger, type SurfaceLedgerEvent } from "./surface-ledger.js";

describe("BrowserController", () => {
  let context: FakeContext;
  let page: FakePage;
  let ledger: SurfaceLedger;
  let cdpRouter: SessionCdpRouter;
  let sink: FakeSink;
  const replaceSiteCookies = () => Promise.resolve();
  const files = new SessionFiles(testSessionFilesRoot());

  beforeEach(async () => {
    page = new FakePage({ title: "Controlled", url: "https://example.test" });
    context = new FakeContext([page]);
    cdpRouter = new SessionCdpRouter(new FakeBrowserCdpBackend(context));
    ledger = new SurfaceLedger(context, {
      claimTarget: (targetId) => cdpRouter.claimTarget(validClaims().sessionId, targetId),
      initialViewport: { devicePixelRatio: 1, height: 720, width: 1_280 },
      rootPages: [page],
    });
    sink = new FakeSink();
    cdpRouter.registerSession(
      validClaims().sessionId,
      await page.targetId(),
      (targetId) => ledger.resolveTarget(targetId),
      files.root,
    );
    await ledger.start();
  });

  it.each([false, true])(
    "records the initial page without waiting for commit (history=%s)",
    async (history) => {
      const navigate = vi.spyOn(ledger, "navigate");
      const held = gate({ label: "initial navigation commit", deadlineMs: 2000 });
      page.cdpSession.responses.set("Page.navigate", () => held.enter());
      const controller = new BrowserController({
        cdpRouter,
        claims: {
          ...validClaims(),
          ...(history ? { navigationAttributionVersion: 1 as const } : {}),
        },
        files,
        ledger,
        replaceSiteCookies,
        signIns: noSignIns(),
        sink,
      });
      try {
        await controller.start();
        const navigation = {
          operationKey: "initial-open",
          url: "https://next.test/",
          ...(history ? { navigationId: "88888888-8888-4888-8888-888888888888" } : {}),
        };
        const result = controller.startInitialNavigation(page, navigation);
        await held.entered;
        if (history)
          expect(navigate).toHaveBeenCalledExactlyOnceWith(
            result.surfaceId,
            navigation.url,
            navigation.navigationId,
          );
        expect(result).toMatchObject({ operationKey: "initial-open", navigation: "submitted" });
        expect(controller.startInitialNavigation(page, navigation)).toEqual(result);
        expect(
          page.cdpSession.sent.filter((command) => command.method === "Page.navigate"),
        ).toHaveLength(1);
        expect(() =>
          controller.startInitialNavigation(page, { ...navigation, url: "https://other.test/" }),
        ).toThrow(/Idempotency/);
      } finally {
        held.release();
        await controller.close();
        await ledger.close();
      }
    },
  );

  it("closes a page that arrives after its additional-open budget expires", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<import("./backend.js").BrowserPage>();
    vi.spyOn(context, "createPage").mockImplementationOnce(() => {
      entered.resolve();
      return release.promise;
    });
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims(),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    vi.useFakeTimers();
    try {
      const requestId = globalThis.crypto.randomUUID();
      const opening = controller.handle({
        type: "cdp.command",
        requestId,
        command: {
          method: browserHostMethods.openTab,
          parameters: { idempotencyKey: "hung-additional" },
        },
      });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(18_000);
      await opening;
      expect(sink.messages).toContainEqual(
        expect.objectContaining({ type: "cdp.error", requestId }),
      );
      const late = new FakePage();
      release.resolve(late);
      await vi.advanceTimersByTimeAsync(0);
      expect(late.closeCount).toBe(1);
      expect(ledger.snapshot()).toHaveLength(1);
    } finally {
      release.resolve(new FakePage());
      vi.useRealTimers();
      await controller.close();
      await ledger.close();
    }
  });
  it.each([
    ["initial", "reply"],
    ["initial", "rejection"],
    ["additional", "reply"],
    ["additional", "rejection"],
  ] as const)("publishes %s navigation failures in page state (%s)", async (kind, failure) => {
    const fail = (page: FakePage) =>
      page.cdpSession.responses.set(
        "Page.navigate",
        failure === "reply"
          ? { errorText: "net::ERR_NAME_NOT_RESOLVED" }
          : () => Promise.reject(new Error("Navigation transport failed")),
      );
    fail(page);
    const createPage = context.createPage.bind(context);
    vi.spyOn(context, "createPage").mockImplementation(async () => {
      const page = await createPage();
      fail(page as FakePage);
      return page;
    });
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims(),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
    });
    try {
      await controller.start();
      let id: string;
      if (kind === "initial")
        id = controller.startInitialNavigation(page, {
          operationKey: "failed-nav",
          url: "https://missing.test/",
        }).surfaceId;
      else {
        await controller.handle({
          type: "cdp.command",
          requestId: globalThis.crypto.randomUUID(),
          command: {
            method: browserHostMethods.openTab,
            parameters: { idempotencyKey: "failed-nav", url: "https://missing.test/" },
          },
        });
        id = ledger.snapshot().find((surface) => surface.id !== ledger.snapshot()[0]?.id)!.id;
      }
      await vi.waitFor(
        () =>
          expect(ledger.snapshot().find((surface) => surface.id === id)).toMatchObject({
            navigationFailed: true,
          }),
        { timeout: 1000 },
      );
      expect(
        sink.messages.some(
          (message) =>
            message.type === "browser.surfaces.changed" &&
            message.surfaces.some((surface) => surface.id === id && "navigationFailed" in surface),
        ),
      ).toBe(true);
    } finally {
      await controller.close();
      await ledger.close();
    }
  });

  it("attributes only viewer input that reaches the page", async () => {
    const passkeys = new HostRelayAuthenticator(() => undefined);
    const record = vi.spyOn(passkeys, "record");
    const controller = new BrowserController({
      passkeys,
      cdpRouter,
      claims: validClaims(),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    const surfaceId = activeSurfaceId();
    const token = "00000000-0000-4000-8000-000000000006";
    try {
      await controller.handle({
        type: "input.pointer",
        surfaceId,
        action: "down",
        button: "none",
        x: 0.5,
        y: 0.5,
        viewportWidth: 1280,
        viewportHeight: 720,
        producerId: token,
      });
      expect(record).not.toHaveBeenCalled();
      await controller.handle({
        type: "input.key",
        surfaceId,
        action: "down",
        code: "Enter",
        key: "Enter",
        modifiers: [],
        producerId: token,
      });
      expect(record).toHaveBeenCalledExactlyOnceWith(await page.targetId(), { person: token });
    } finally {
      await controller.close();
      await ledger.close();
      passkeys.close();
    }
  });

  it("attributes agent script and page changes to the agent, but not observation", async () => {
    const passkeys = new HostRelayAuthenticator(() => undefined);
    const record = vi.spyOn(passkeys, "record");
    const controller = new BrowserController({
      passkeys,
      cdpRouter,
      claims: validClaims(),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    const targetId = await page.targetId();
    try {
      const attached = await cdpRouter.send(validClaims().sessionId, {
        method: "Target.attachToTarget",
        parameters: { targetId, flatten: true },
      });
      const sessionId = (attached as { sessionId: string }).sessionId;
      const agent = (method: string, parameters: Record<string, unknown> = {}) =>
        controller.handle({
          type: "cdp.command",
          requestId: globalThis.crypto.randomUUID(),
          command: { method, sessionId, parameters },
        });
      await agent("DOM.getDocument");
      expect(record).not.toHaveBeenCalled();
      // Either can let page script call navigator.credentials within a person's input window.
      await agent("Runtime.evaluate", { expression: "1" });
      await agent("Emulation.setDeviceMetricsOverride", {
        width: 800,
        height: 600,
        deviceScaleFactor: 1,
        mobile: false,
      });
      expect(record.mock.calls).toEqual([
        [targetId, "agent"],
        [targetId, "agent"],
      ]);
    } finally {
      await controller.close();
      await ledger.close();
      passkeys.close();
    }
  });

  it.each(["text", "composition", "paste"] as const)(
    "attributes %s before a ceremony inside its dispatch, including another viewer",
    async (kind) => {
      const cdp = page.cdpSession;
      cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
      cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
      const causes: unknown[] = [];
      const passkeys = new HostRelayAuthenticator(() => ({
        sessionId: "session",
        surfaceId: activeSurfaceId(),
        send: (message) => {
          if (message.type === "passkey.ceremony") {
            causes.push(message.cause);
            passkeys.result("session", {
              type: "passkey.result",
              ceremonyId: message.ceremonyId,
              outcome: { kind: "refused", error: "NotAllowedError" },
            });
          }
        },
      }));
      const controller = new BrowserController({
        passkeys,
        cdpRouter,
        claims: validClaims({ editingVersion: 2, clipboard: false }),
        files,
        ledger,
        replaceSiteCookies,
        signIns: noSignIns(),
        sink,
      });
      await controller.start();
      try {
        await flushMicrotasks();
        const world = cdp.sent.find(
          (entry) =>
            entry.method === "Runtime.addBinding" &&
            String(entry.parameters?.executionContextName).startsWith("opensteer-editing-"),
        )!.parameters!;
        cdp.emit("Runtime.executionContextCreated", {
          context: {
            id: 7,
            uniqueId: crypto.randomUUID(),
            name: world.executionContextName,
            origin: "https://example.test",
            auxData: { frameId: "main", isDefault: false },
          },
        });
        cdp.emit("Runtime.bindingCalled", {
          name: world.name,
          executionContextId: 7,
          payload: JSON.stringify({
            fieldId: "field",
            field: { kind: "text", multiline: false, sensitive: false },
            caret: null,
          }),
        });
        await flushMicrotasks();
        const token = "00000000-0000-4000-8000-000000000006";
        const other = "00000000-0000-4000-8000-000000000007";
        const targetId = await page.targetId();
        cdp.responses.set("Runtime.evaluate", { result: { value: { ok: true } } });
        const ceremony = () => {
          void passkeys.ceremony({
            op: "get",
            options: PublicKeyCredentialRequestOptionsJSONSchema.parse({ challenge: "AQID" }),
            targetId,
            documentId: "document",
            deadline: Date.now() + 1000,
            origin: "https://example.test",
            rpId: "example.test",
            clientDataJSON: serializeClientData({
              type: "webauthn.get",
              challenge: "AQID",
              origin: "https://example.test",
            }),
            signal: new AbortController().signal,
          });
          return {};
        };
        cdp.responses.set("Input.insertText", ceremony);
        cdp.responses.set("Input.imeSetComposition", ceremony);
        const send = async () => {
          const context = sink.messages
            .filter((message) => message.type === "browser.editing")
            .at(-1);
          if (context?.type !== "browser.editing") throw new Error("Missing editing context");
          const edit = { contextId: context.context.contextId, text: "x", before: "", after: "" };
          await controller.handle(
            kind === "paste"
              ? {
                  type: "clipboard.paste",
                  surfaceId: activeSurfaceId(),
                  text: "x",
                  producerId: token,
                }
              : kind === "text"
                ? { type: "input.text", surfaceId: activeSurfaceId(), edit, producerId: token }
                : {
                    type: "input.compose",
                    surfaceId: activeSurfaceId(),
                    composition: { ...edit, selectionStart: 1, selectionEnd: 1 },
                    producerId: token,
                  },
          );
        };
        await send();
        expect(causes).toEqual([{ person: token }]);
        passkeys.forget(targetId);
        passkeys.record(targetId, { person: other });
        causes.length = 0;
        await send();
        expect(causes).toEqual(["unknown"]);
        if (kind !== "paste") {
          passkeys.forget(targetId);
          passkeys.record(targetId, { person: other });
          causes.length = 0;
          cdp.responses.set("Runtime.evaluate", {
            result: { value: { ok: false, reason: "selection-changed" } },
          });
          await send();
          expect(causes).toEqual([]);
          expect(passkeys.cause(targetId)).toEqual({ person: other });
        }
      } finally {
        await controller.close();
        await ledger.close();
        passkeys.close();
      }
    },
  );

  it.each(["c", "x"] as const)(
    "resolves v2 primary %s to Cocoa and publishes the selected text",
    async (key) => {
      const controller = new BrowserController({
        cdpRouter,
        claims: validClaims({ editingVersion: 2, clipboard: false }),
        files,
        ledger,
        replaceSiteCookies,
        platform: "darwin",
        signIns: noSignIns(),
        sink,
      });
      await controller.start();
      try {
        expect(sink.messages.find((message) => message.type === "browser.snapshot")).toMatchObject({
          editingVersion: 2,
          clipboard: false,
        });
        const surfaceId = activeSurfaceId();
        await controller.handle({ type: "input.command", surfaceId, command: "selectAll" });
        expect(page.cdpSession.sent).toContainEqual(
          expect.objectContaining({
            method: "Input.dispatchKeyEvent",
            parameters: expect.objectContaining({ commands: ["selectAll"], modifiers: 4 }),
          }),
        );
        const consumerToken = crypto.randomUUID();
        page.cdpSession.responses.set("Runtime.evaluate", { result: { value: "selected" } });
        await controller.handle({
          type: "input.key",
          surfaceId,
          action: "down",
          key,
          code: key === "c" ? "KeyC" : "KeyX",
          modifiers: ["primary"],
          consumerToken,
        });
        expect(page.cdpSession.sent).toContainEqual(
          expect.objectContaining({
            method: "Input.dispatchKeyEvent",
            parameters: expect.objectContaining({
              commands: [key === "c" ? "copy" : "cut"],
              modifiers: 4,
            }),
          }),
        );
        expect(sink.messages).toContainEqual({
          type: "clipboard.data",
          surfaceId,
          text: "selected",
          consumerToken,
        });
        const before = page.cdpSession.sent.length;
        await controller.handle({
          type: "clipboard.copy",
          surfaceId,
          operationId: crypto.randomUUID(),
        });
        expect(
          page.cdpSession.sent
            .slice(before)
            .some((entry) => entry.method === "Input.dispatchKeyEvent"),
        ).toBe(false);
        expect(sink.messages.at(-1)).toMatchObject({
          type: "browser.error",
          error: { code: "forbidden" },
        });
      } finally {
        await controller.close();
        await ledger.close();
      }
    },
  );
  it("settles each ownership-refused clipboard operation once with its consumer", async () => {
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims({ editingVersion: 1 }),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
      clipboard: { open: async () => ({ close: async () => null }) },
    });
    await controller.start();
    try {
      const surfaceId = activeSurfaceId();
      await controller.handle({
        type: "input.key",
        surfaceId,
        action: "down",
        key: "a",
        code: "KeyA",
        modifiers: [],
        producerId: "00000000-0000-4000-8000-000000000001",
      });
      for (const type of ["clipboard.copy", "clipboard.cut", "clipboard.paste-data"] as const) {
        const operationId = crypto.randomUUID(),
          consumerToken = crypto.randomUUID();
        const identity = {
          surfaceId,
          operationId,
          consumerToken,
          producerId: "00000000-0000-4000-8000-000000000002",
        };
        await controller.handle(
          type === "clipboard.paste-data"
            ? { ...identity, type, items: [{ type: "text/plain", size: 1 }] }
            : { ...identity, type },
        );
        expect(
          sink.messages.filter(
            (m) => m.type === "clipboard.result" && m.operationId === operationId,
          ),
        ).toEqual([
          { type: "clipboard.result", surfaceId, operationId, consumerToken, outcome: "refused" },
        ]);
      }
    } finally {
      await controller.close();
      await ledger.close();
    }
  });
  it("compiles baseline Cocoa editing chords on keydown only", async () => {
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims(),
      files,
      ledger,
      replaceSiteCookies,
      platform: "darwin",
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    try {
      const surfaceId = activeSurfaceId();
      const chords = [
        ["a", "KeyQ", ["meta"], "selectAll"],
        ["z", "KeyZ", ["meta"], "undo"],
        ["Z", "KeyZ", ["shift", "meta"], "redo"],
        ["ArrowLeft", "ArrowLeft", ["meta"], "moveToLeftEndOfLine"],
        ["Backspace", "Backspace", ["meta"], "deleteToBeginningOfLine"],
        ["a", "KeyA", ["control"], "moveToBeginningOfLine"],
        ["b", "KeyB", ["control"], "moveBackward"],
        ["f", "KeyF", ["control"], "moveForward"],
        ["p", "KeyP", ["control"], "moveUp"],
        ["n", "KeyN", ["control"], "moveDown"],
        ["h", "KeyH", ["control"], "deleteBackward"],
        ["d", "KeyD", ["control"], "deleteForward"],
        ["ArrowLeft", "ArrowLeft", ["shift"], "moveBackwardAndModifySelection"],
        ["ArrowRight", "ArrowRight", ["shift"], "moveForwardAndModifySelection"],
        ["Home", "Home", [], "moveToBeginningOfDocument"],
        ["End", "End", ["shift"], "moveToEndOfDocumentAndModifySelection"],
      ] as const;
      for (const [key, code, modifiers, command] of chords) {
        await controller.handle({
          type: "input.key",
          surfaceId,
          action: "down",
          key,
          code,
          modifiers: [...modifiers],
        });
        expect(commandsNamed("Input.dispatchKeyEvent", page).at(-1)?.parameters).toMatchObject({
          commands: [command],
        });
        await controller.handle({
          type: "input.key",
          surfaceId,
          action: "up",
          key,
          code,
          modifiers: [...modifiers],
        });
        expect(commandsNamed("Input.dispatchKeyEvent", page).at(-1)?.parameters).not.toHaveProperty(
          "commands",
        );
      }
    } finally {
      await controller.close();
      await ledger.close();
    }
  });
  it("does not revive an earlier context menu when the same controller clicks again", async () => {
    const cdp = page.cdpSession;
    cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
    cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
    cdp.responses.set("DOM.getFrameOwner", () => {
      throw new Error("The root has no owner.");
    });
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims({ editingVersion: 1 }),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
      clipboard: { machineClipboardShared: false, open: async () => ({ close: async () => null }) },
    });
    await controller.start();
    try {
      await flushMicrotasks();
      const world = cdp.sent.find(
        (entry) =>
          entry.method === "Runtime.addBinding" &&
          String(entry.parameters?.executionContextName).startsWith("opensteer-editing-"),
      )!.parameters!;
      cdp.emit("Runtime.executionContextCreated", {
        context: {
          id: 7,
          uniqueId: globalThis.crypto.randomUUID(),
          name: world.executionContextName,
          origin: "https://example.test",
          auxData: { frameId: "main", isDefault: false },
        },
      });
      const consumerToken = globalThis.crypto.randomUUID();
      const pointer = {
        type: "input.pointer" as const,
        button: "right" as const,
        surfaceId: activeSurfaceId(),
        x: 0.2,
        y: 0.2,
        viewportWidth: 1280,
        viewportHeight: 720,
        consumerToken,
      };
      await controller.handle({ ...pointer, action: "down" });
      const geometry = Promise.withResolvers<unknown>();
      cdp.responses.set("Page.getLayoutMetrics", () => geometry.promise);
      const menu = () =>
        cdp.emit("Runtime.bindingCalled", {
          name: world.name,
          executionContextId: 7,
          payload: JSON.stringify({ kind: "menu", x: 20, y: 20, editable: true, selection: false }),
        });
      menu();
      await controller.handle({ ...pointer, action: "up" });
      const key = {
        type: "input.key" as const,
        surfaceId: activeSurfaceId(),
        key: "Escape",
        code: "Escape",
        modifiers: [],
      };
      await controller.handle({ ...key, action: "down" });
      await controller.handle({ ...key, action: "up" });
      await controller.handle({ ...pointer, action: "down" });
      geometry.resolve({ visualViewport: { clientWidth: 1280, clientHeight: 720 } });
      await flushMicrotasks();
      expect(
        sink.messages.filter((message) => message.type === "browser.contextmenu"),
      ).toHaveLength(0);
      menu();
      await flushMicrotasks();
      expect(
        sink.messages.filter((message) => message.type === "browser.contextmenu"),
      ).toMatchObject([{ consumerToken }]);
      await controller.handle({ ...pointer, action: "up" });
    } finally {
      await controller.close();
      await ledger.close();
    }
  });

  it("normalizes the caret to the native crop and refreshes stationary fields on crop changes", async () => {
    const cdp = page.cdpSession;
    cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
    cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
    cdp.responses.set("DOM.getFrameOwner", () => {
      throw new Error("The root has no owner.");
    });
    let capture = { width: 640, height: 360, revision: 1, rasterScale: 1 };
    const listeners = new Set<() => void>();
    Object.defineProperty(page, "capture", {
      value: {
        read: () => capture,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    });
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims({ editingVersion: 1 }),
      files,
      ledger,
      replaceSiteCookies,
      signIns: noSignIns(),
      sink,
      clipboard: { open: async () => ({ close: async () => null }) },
    });
    await controller.start();
    try {
      await flushMicrotasks();
      const world = cdp.sent.find(
        (entry) =>
          entry.method === "Runtime.addBinding" &&
          String(entry.parameters?.executionContextName).startsWith("opensteer-editing-"),
      )!.parameters!;
      cdp.emit("Runtime.executionContextCreated", {
        context: {
          id: 7,
          uniqueId: globalThis.crypto.randomUUID(),
          name: world.executionContextName,
          origin: "https://example.test",
          auxData: { frameId: "main", isDefault: false },
        },
      });
      const publish = () =>
        cdp.emit("Runtime.bindingCalled", {
          name: world.name,
          executionContextId: 7,
          payload: JSON.stringify({
            fieldId: "field",
            field: { kind: "text", multiline: false, sensitive: false },
            caret: { x: 160, y: 90, height: 18 },
          }),
        });
      publish();
      await flushMicrotasks();
      const latest = () =>
        sink.messages.filter((message) => message.type === "browser.editing").at(-1);
      expect(latest()).toMatchObject({ context: { caret: { x: 0.25, y: 0.25, height: 0.05 } } });
      const before = cdp.sent.filter(
        (entry) => entry.parameters?.expression === "globalThis.editingOwner?.publish()",
      ).length;
      capture = { width: 320, height: 180, revision: 2, rasterScale: 1 };
      for (const listener of listeners) listener();
      expect(
        cdp.sent.filter(
          (entry) => entry.parameters?.expression === "globalThis.editingOwner?.publish()",
        ),
      ).toHaveLength(before + 1);
      publish();
      await flushMicrotasks();
      expect(latest()).toMatchObject({ context: { caret: { x: 0.5, y: 0.5, height: 0.1 } } });
    } finally {
      await controller.close();
      await ledger.close();
    }
    expect(listeners.size).toBe(0);
  });

  it("restores a durable URL beyond the public open limit only with a negotiated stable ID", async () => {
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims({ workspaceTabRestoreVersion: 1 }),
      files,
      ledger,
      replaceSiteCookies,
      platform: "darwin",
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    try {
      const url = `https://example.test/${"x".repeat(9000)}#/document/42`;
      expect(
        BrowserSessionTabOpenCommandSchema.safeParse({
          type: "browser.tab.open",
          sessionId: validClaims().sessionId,
          idempotencyKey: "public",
          url,
        }).success,
      ).toBe(false);
      const surfaceId = BrowserSurfaceIdSchema.parse("surface_durable-long");
      const requestId = globalThis.crypto.randomUUID();
      await controller.handle({
        type: "cdp.command",
        requestId,
        command: {
          method: browserHostMethods.openTab,
          parameters: { idempotencyKey: "restore:long", surfaceId, url },
        },
      });
      expect(
        sink.messages.find(
          (message) => message.type === "cdp.result" && message.requestId === requestId,
        ),
      ).toMatchObject({ result: { tabId: surfaceId } });
      expect(ledger.binding(surfaceId)?.page).toBeDefined();
      expect((ledger.binding(surfaceId)!.page as FakePage).cdpSession.sent).toContainEqual({
        method: "Page.navigate",
        parameters: { url },
      });
    } finally {
      await controller.close();
      await ledger.close();
    }
  });
  it("disposes a durable exact ID despite inventory churn and makes repeated disposal harmless", async () => {
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims({ workspaceTabRestoreVersion: 1 }),
      files,
      ledger,
      replaceSiteCookies,
      platform: "darwin",
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    try {
      const original = ledger.snapshot()[0]!;
      const staleRevision = ledger.inventoryRevision;
      await ledger.openSurface({ activate: false });
      for (let index = 0; index < 2; index++) {
        const requestId = globalThis.crypto.randomUUID();
        await controller.handle({
          type: "cdp.command",
          requestId,
          command: {
            method: browserHostMethods.closeTab,
            parameters: { surfaceId: original.id, inventoryRevision: staleRevision, durable: true },
          },
        });
        expect(
          sink.messages.find(
            (message) => message.type === "cdp.result" && message.requestId === requestId,
          ),
        ).toMatchObject({ result: { outcome: "tab-closed" } });
      }
      expect(page.closeCount).toBe(1);
      expect(ledger.snapshot().some((surface) => surface.id === original.id)).toBe(false);
      expect(ledger.snapshot()).toHaveLength(1);
    } finally {
      await controller.close();
      await ledger.close();
    }
  });
  it("authorizes for the session and intercepts page-bound login fills without Chromium dispatch", async () => {
    const controller = createController();
    await controller.start();
    const authorize = vi.spyOn(HostSignIns.prototype, "authorize");
    const fill = vi.spyOn(HostSignIns.prototype, "fill").mockResolvedValue("filled");
    try {
      await controller.handle({
        type: "login.authorize",
        operationId: "00000000-0000-4000-8000-000000000001",
        site: "https://example.com",
        workspaceId:
          "wsp_00000000-0000-4000-8000-000000000001" as HostLoginAuthorizeInput["workspaceId"],
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requester: {
          deploymentId: "dep_test",
          deploymentName: "Test",
          workspaceName: "Test",
          threadTitle: "Test",
          reason: "Test",
        },
      });
      expect(authorize.mock.calls.at(-1)?.[0]).toMatchObject({
        sessionId: validClaims().sessionId,
        site: "https://example.com",
      });
      expect(authorize.mock.calls.at(-1)?.[0]).not.toHaveProperty("pageUrl");
      const attached = await cdpRouter.send(validClaims().sessionId, {
        method: "Target.attachToTarget",
        parameters: { targetId: await page.targetId(), flatten: true },
      });
      const sessionId = (attached as { sessionId: string }).sessionId;
      const loginRef = `lgn_${"a".repeat(32)}`;
      await controller.handle({
        type: "cdp.command",
        requestId: "00000000-0000-4000-8000-0000000000f1",
        command: {
          method: "Opensteer.fillLogin",
          sessionId,
          parameters: { loginRef, field: "password" },
        },
      });
      expect(fill).toHaveBeenCalledWith({
        loginRef,
        field: "password",
        sessionId: validClaims().sessionId,
        targetId: await page.targetId(),
      });
      expect(sink.messages).toContainEqual({
        type: "cdp.result",
        requestId: "00000000-0000-4000-8000-0000000000f1",
        result: { status: "filled" },
      });
      for (const command of [
        { method: "Opensteer.fillLogin", parameters: { loginRef, field: "password" } },
        {
          method: "Opensteer.fillLogin",
          sessionId: "unknown",
          parameters: { loginRef, field: "password" },
        },
        { method: "Opensteer.fillLogin", sessionId, parameters: { loginRef, field: "bad-secret" } },
      ])
        await controller.handle({
          type: "cdp.command",
          requestId: "00000000-0000-4000-8000-0000000000f2",
          command,
        });
      expect(fill).toHaveBeenCalledTimes(1);
      expect(
        sink.messages.filter(
          (m) => m.type === "cdp.error" && m.requestId === "00000000-0000-4000-8000-0000000000f2",
        ),
      ).toHaveLength(3);
      expect(JSON.stringify(sink.messages)).not.toContain("bad-secret");
      expect(commandsNamed("Opensteer.fillLogin", page)).toEqual([]);
    } finally {
      authorize.mockRestore();
      fill.mockRestore();
      await controller.close();
      await ledger.close();
    }
  });

  it.each([false, true])(
    "reserves capture capacity only for picture targets (control first: %s)",
    async (controlFirst) => {
      const controller = createController();
      await controller.start();
      const pages = [page];
      for (let index = 1; index < 10; index += 1) {
        const surface = await ledger.openSurface({ activate: false });
        pages.push(ledger.binding(surface.id)!.page as FakePage);
      }
      await flushMicrotasks();
      const surfaces = ledger.snapshot();
      expect(surfaces).toHaveLength(10);
      const native = surfaces[8]!;
      const subscribeControl = () =>
        controller.handle({ type: "stream.subscribe", surfaceId: native.id, frames: false });
      if (controlFirst) await subscribeControl();
      for (const surface of surfaces.slice(0, 8))
        await controller.handle({ type: "stream.subscribe", surfaceId: surface.id });
      if (!controlFirst) await subscribeControl();
      expect(sink.messages.filter((message) => message.type === "browser.error")).toEqual([]);
      expect(commandsNamed("Page.startScreencast", pages[8]!)).toHaveLength(0);
      pages[8]!.cdpSession.emit("Page.javascriptDialogOpening", {
        message: "Native dialog",
        type: "alert",
      });
      await flushMicrotasks();
      expect(sink.messages).toContainEqual(
        expect.objectContaining({
          type: "browser.dialog.changed",
          surfaceId: native.id,
          dialog: expect.objectContaining({ message: "Native dialog" }),
        }),
      );
      await controller.handle({ type: "stream.subscribe", surfaceId: surfaces[0]!.id });
      await controller.handle({ type: "stream.subscribe", surfaceId: surfaces[9]!.id });
      await controller.handle({ type: "stream.subscribe", surfaceId: native.id });
      expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(2);
      expect(sink.messages).toContainEqual(
        expect.objectContaining({
          type: "browser.error",
          error: expect.objectContaining({ reason: "browser-capture-limit" }),
        }),
      );
      await controller.handle({
        type: "stream.subscribe",
        surfaceId: surfaces[0]!.id,
        frames: false,
      });
      await controller.handle({ type: "stream.subscribe", surfaceId: surfaces[9]!.id });
      expect(commandsNamed("Page.startScreencast", pages[9]!)).toHaveLength(1);
      await controller.handle({ type: "stream.unsubscribe", surfaceId: surfaces[9]!.id });
      await controller.handle({ type: "stream.subscribe", surfaceId: surfaces[0]!.id });
      expect(commandsNamed("Page.startScreencast", pages[0]!)).toHaveLength(2);
      expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(2);
      await controller.close();
      await ledger.close();
    },
  );

  it.each([
    [1, 1],
    [2, 2],
    [0, 2],
    [1, 2],
  ])(
    "clips a panned visual viewport at agent DPR %s / native DPR %s",
    async (agentDpr, nativeDpr) => {
      const controller = createController();
      await controller.start();
      const targetId = await page.targetId();
      await ledger.agentMetrics(targetId, {
        width: 709,
        height: 729,
        deviceScaleFactor: agentDpr,
        mobile: false,
      });
      page.cdpSession.responses.set("Page.getLayoutMetrics", {
        layoutViewport: { clientWidth: 694 * nativeDpr },
        cssLayoutViewport: { clientWidth: 694 },
        cssVisualViewport: {
          pageX: 23.6,
          pageY: 47.2,
          clientWidth: 347.2,
          clientHeight: 356.4,
          scale: 2,
        },
      });
      await controller.handle({
        type: "cdp.command",
        requestId: "00000000-0000-4000-8000-000000000911",
        command: { method: "Target.attachToTarget", parameters: { targetId } },
      });
      const attached = sink.messages.find(
        (message) => message.type === "cdp.result" && message.requestId.endsWith("911"),
      );
      if (attached?.type !== "cdp.result") throw new Error("Missing attach result");
      const sessionId = (attached.result as { sessionId: string }).sessionId;
      const capture = (parameters: Record<string, unknown>) =>
        controller.handle({
          type: "cdp.command",
          requestId: "00000000-0000-4000-8000-000000000912",
          command: { method: "Page.captureScreenshot", parameters, sessionId },
        });
      const dpr = agentDpr || nativeDpr;
      await capture({});
      expect(command("Page.captureScreenshot", page)?.parameters).toMatchObject({
        captureBeyondViewport: false,
        clip: { x: 24, y: 47, width: 347, height: 356, scale: 1 / dpr },
      });
      await capture({ clip: { x: 3.25, y: 7.75, width: 111.5, height: 81.25, scale: 1.5 } });
      expect(command("Page.captureScreenshot", page)?.parameters).toMatchObject({
        clip: { x: 3.25, y: 7.75, width: 111.5, height: 81.25, scale: 1.5 / dpr },
      });
      const beyond = {
        captureBeyondViewport: true,
        clip: { x: 1, y: 2, width: 30, height: 40, scale: 2 },
      };
      await capture(beyond);
      expect(command("Page.captureScreenshot", page)?.parameters).toEqual(beyond);
      await controller.close();
      await ledger.close();
    },
  );

  it("publishes state immediately and starts one screencast only while subscribed", async () => {
    const controller = createController();
    await controller.start();

    expect(sink.messages.slice(0, 1).map((message) => message.type)).toEqual(["browser.snapshot"]);
    expect(sink.messages[0]).toMatchObject({ dialog: null, state: "ready" });
    // Page events first, so a dialog the page opens while it is sized is seen;
    // the announced page then installs its script-target observer and
    // prepares its private icon world.
    expect(withoutTitleSamples(page.cdpSession.sent).map((command) => command.method)).toEqual([
      "Page.enable",
      "Emulation.setDeviceMetricsOverride",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.createIsolatedWorld",
    ]);
    await controller.handle({ type: "stream.subscribe" });
    expect(page.cdpSession.sent.map((command) => command.method)).toEqual(
      expect.arrayContaining(["Page.enable", "Page.startScreencast"]),
    );
    // The raster bound is twice the page's CSS size, for a Retina viewer.
    expect(command("Page.startScreencast", page)?.parameters).toMatchObject({
      maxHeight: 1_440,
      maxWidth: 2_560,
    });
    expect(commandsNamed("Emulation.setDeviceMetricsOverride", page)).toHaveLength(1);
    expect(commandsNamed("Page.captureScreenshot", page)).toHaveLength(0);
    page.cdpSession.emit("Page.screencastFrame", {
      data: jpeg(1_280, 720).toString("base64"),
      metadata: { deviceHeight: 720, deviceWidth: 1_280 },
      sessionId: 1,
    });
    await flushMicrotasks();
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]?.header).toMatchObject({
      rasterHeight: 720,
      rasterWidth: 1_280,
      viewportHeight: 720,
      viewportWidth: 1_280,
    });
    page.cdpSession.emit("Page.screencastFrame", {
      data: jpeg(60, 40).toString("base64"),
      metadata: { deviceHeight: 600, deviceWidth: 900 },
      sessionId: 2,
    });
    await flushMicrotasks();
    expect(sink.frames).toHaveLength(1);
    expect(command("Page.screencastFrameAck", page)?.parameters).toEqual({ sessionId: 2 });
    // A picture of a size the page never had means Chrome put the view back
    // at its window's size: the view is sized again and the cast restarted.
    expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(1);
    expect(commandsNamed("Page.startScreencast", page)).toHaveLength(2);
    expect(command("Emulation.setVisibleSize", page)?.parameters).toEqual({
      height: 720,
      width: 1_280,
    });
    await controller.handle({
      height: 650,
      surfaceId: activeSurfaceId(),
      type: "viewport.set",
      width: 900,
    });
    expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(2);
    expect(commandsNamed("Page.startScreencast", page)).toHaveLength(3);
    expect(command("Page.startScreencast", page)?.parameters).toMatchObject({
      maxHeight: 1_300,
      maxWidth: 1_800,
    });
    // Fitting to the size the page already shows changes nothing: the cast
    // keeps running.
    await controller.handle({
      height: 650,
      surfaceId: activeSurfaceId(),
      type: "viewport.set",
      width: 900,
    });
    expect(commandsNamed("Page.startScreencast", page)).toHaveLength(3);
    page.cdpSession.emit("Page.screencastFrame", {
      data: jpeg(900, 650).toString("base64"),
      metadata: { deviceHeight: 650, deviceWidth: 900 },
      sessionId: 3,
    });
    await flushMicrotasks();
    expect(sink.frames.at(-1)?.header).toMatchObject({
      viewportHeight: 650,
      viewportWidth: 900,
    });
    await controller.handle({ type: "stream.unsubscribe" });
    expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(3);
    await controller.close();
    expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(3);
    await ledger.close();
  });

  it.each([
    { width: 390, height: 4300, rasterWidth: 391, rasterHeight: 4311 },
    { width: 4300, height: 390, rasterWidth: 7673, rasterHeight: 696 },
  ])(
    "accepts native raster aspect-fitting within integer CDP bounds: $width × $height",
    async ({ width, height, rasterWidth, rasterHeight }) => {
      const capture = { width, height, rasterScale: 2, revision: 1 };
      Object.assign(page, {
        capture: { read: () => capture, subscribe: () => () => undefined },
        applyGeometry: async () => undefined,
      });
      const controller = createController();
      await controller.start();
      await controller.handle({
        type: "viewport.set",
        surfaceId: activeSurfaceId(),
        width,
        height,
      });
      await controller.handle({ type: "stream.subscribe", captureRegion: true });
      page.cdpSession.emit("Page.screencastFrame", {
        sessionId: 1,
        data: jpeg(rasterWidth, rasterHeight).toString("base64"),
        metadata: { deviceWidth: width, deviceHeight: height },
      });
      await flushMicrotasks();
      expect(sink.frames).toHaveLength(1);
      expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(0);
      await controller.close();
      await ledger.close();
    },
  );

  it("acknowledges malformed and undecodable frames and keeps the cast alive", async () => {
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "stream.subscribe" });
    page.cdpSession.emit("Page.screencastFrame", { sessionId: 8, metadata: {} });
    page.cdpSession.emit("Page.screencastFrame", {
      sessionId: 9,
      data: "invalid",
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
    });
    await flushMicrotasks();
    expect(commandsNamed("Page.screencastFrameAck", page).map((entry) => entry.parameters)).toEqual(
      [{ sessionId: 8 }, { sessionId: 9 }],
    );
    expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(0);
    page.cdpSession.emit("Page.screencastFrame", {
      sessionId: 10,
      data: jpeg(1280, 720).toString("base64"),
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
    });
    await flushMicrotasks();
    expect(sink.frames).toHaveLength(1);
    await controller.close();
    await ledger.close();
  });

  it.each([false, true])(
    "restarts after A→B→A cancels a cast attempt (startup pending: %s)",
    async (pending) => {
      let capture = { width: 1280, height: 720, rasterScale: 1, revision: 1 };
      const listeners = new Set<() => void>();
      const attempts: AbortSignal[] = [];
      Object.assign(page, {
        capture: {
          read: () => capture,
          subscribe: (listener: () => void) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
        applyGeometry: async () => undefined,
        settleRendering: async (signal: AbortSignal) => {
          attempts.push(signal);
          if (pending && attempts.length === 1)
            await new Promise<void>((resolve) =>
              signal.addEventListener("abort", () => resolve(), { once: true }),
            );
        },
      });
      const controller = createController();
      await controller.start();
      const first = activeSurfaceId();
      const second = await ledger.openSurface({ activate: false });
      await flushMicrotasks();
      const subscription = controller.handle({ type: "stream.subscribe", captureRegion: true });
      await flushMicrotasks();
      const starts = commandsNamed("Page.startScreencast", page).length;
      await Promise.all([ledger.activate(second.id), ledger.activate(first)]);
      await subscription;
      await flushMicrotasks();
      if (pending) expect(attempts[0]?.aborted).toBe(true);
      capture = { width: 800, height: 600, rasterScale: 1, revision: 2 };
      for (const listener of listeners) listener();
      await flushMicrotasks();
      expect(commandsNamed("Page.startScreencast", page)).toHaveLength(starts + 1);
      expect(attempts.at(-1)?.aborted).toBe(false);
      page.cdpSession.emit("Page.screencastFrame", {
        sessionId: 1,
        data: jpeg(800, 600).toString("base64"),
        metadata: { deviceWidth: 800, deviceHeight: 600 },
      });
      await flushMicrotasks();
      expect(sink.frames.at(-1)?.header.capture).toEqual({ width: 800, height: 600, revision: 2 });
      page.cdpSession.emit("Page.javascriptDialogOpening", { message: "Resume", type: "alert" });
      page.cdpSession.emit("Page.javascriptDialogClosed", {});
      await flushMicrotasks();
      await controller.handle({ type: "viewport.set", surfaceId: first, width: 1300, height: 800 });
      expect(commandsNamed("Page.startScreencast", page).length).toBeGreaterThan(starts + 1);
      await controller.close();
      await ledger.close();
    },
  );

  it.each(["input.pointer", "input.wheel"] as const)(
    "distinguishes pending/stale geometry from unsupported cropped %s",
    async (type) => {
      let capture: { width: number; height: number; rasterScale: number; revision: number } | null =
        null;
      Object.assign(page, {
        capture: { read: () => capture, subscribe: () => () => undefined },
        applyGeometry: async () => undefined,
      });
      const controller = createController();
      await controller.start();
      await controller.handle({ type: "stream.subscribe", captureRegion: true });
      const point = {
        surfaceId: activeSurfaceId(),
        viewportWidth: 1280,
        viewportHeight: 720,
        x: 0.5,
        y: 0.5,
      };
      const input =
        type === "input.pointer"
          ? { ...point, type, action: "move" as const, button: "none" as const }
          : { ...point, type, deltaX: 0, deltaY: 12 };
      const refusal = () =>
        sink.messages.filter((message) => message.type === "browser.error").at(-1);
      await controller.handle(input);
      expect(refusal()).toMatchObject({ error: { reason: "browser-input-stale-geometry" } });
      capture = { width: 1280, height: 720, rasterScale: 1, revision: 1 };
      await controller.handle({
        ...input,
        geometryRevision: (ledger.active()!.surface.geometryRevision ?? 0) + 1,
      });
      expect(refusal()).toMatchObject({ error: { reason: "browser-input-stale-geometry" } });
      await controller.handle({ ...input, viewportWidth: 1200 });
      expect(refusal()).toMatchObject({ error: { reason: "browser-input-stale-geometry" } });
      capture = { width: 800, height: 600, rasterScale: 1, revision: 2 };
      await controller.handle(input);
      expect(refusal()).toMatchObject({ error: { reason: "browser-capture-region-unsupported" } });
      await controller.handle({ ...input, captureRevision: 1 });
      expect(refusal()).toMatchObject({ error: { reason: "browser-input-stale-geometry" } });
      await controller.close();
      await ledger.close();
    },
  );

  it("admits legacy full-layout native aiming and refuses legacy cropped aiming", async () => {
    let capture = { width: 1280, height: 720, rasterScale: 1, revision: 1 };
    const listeners = new Set<() => void>();
    Object.assign(page, {
      capture: {
        read: () => capture,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      applyGeometry: async () => undefined,
    });
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "stream.subscribe", captureRegion: true });
    const input = {
      type: "input.wheel" as const,
      surfaceId: activeSurfaceId(),
      viewportWidth: 1280,
      viewportHeight: 720,
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: 12,
    };
    await controller.handle(input);
    expect(command("Input.dispatchMouseEvent", page)?.parameters).toMatchObject({ x: 640, y: 360 });
    capture = { width: 800, height: 600, rasterScale: 1, revision: 2 };
    for (const listener of listeners) listener();
    await flushMicrotasks();
    await controller.handle(input);
    expect(sink.messages).toContainEqual(
      expect.objectContaining({
        type: "browser.error",
        error: expect.objectContaining({ reason: "browser-capture-region-unsupported" }),
      }),
    );
    await controller.handle({
      ...input,
      captureRevision: 2,
      geometryRevision: ledger.active()!.surface.geometryRevision,
    });
    expect(command("Input.dispatchMouseEvent", page)?.parameters).toMatchObject({ x: 400, y: 300 });
    expect(commandsNamed("Page.getLayoutMetrics", page)).toHaveLength(0);
    await controller.close();
    await ledger.close();
  });

  it("returns from native startup without a descriptor and restarts when it is published", async () => {
    let capture: { width: number; height: number; rasterScale: number; revision: number } | null =
      null;
    const listeners = new Set<() => void>();
    Object.assign(page, {
      capture: {
        read: () => capture,
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      settleRendering: async () => undefined,
      applyGeometry: async () => undefined,
    });
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "stream.subscribe", captureRegion: true });
    expect(commandsNamed("Page.startScreencast", page)).toHaveLength(0);
    capture = { width: 1280, height: 720, rasterScale: 1, revision: 1 };
    for (const listener of listeners) listener();
    await flushMicrotasks();
    expect(commandsNamed("Page.startScreencast", page)).toHaveLength(1);
    await controller.close();
    await ledger.close();
  });

  it("maps input and frames with the size the page was given, a scrollbar included", async () => {
    // Chromium's visual viewport leaves out a classic or styled scrollbar,
    // while the screencast pictures the whole viewport the page was given.
    page.cdpSession.responses.set("Page.getLayoutMetrics", {
      layoutViewport: { clientWidth: 1_265 },
      cssLayoutViewport: { clientWidth: 1_265 },
      cssVisualViewport: { clientHeight: 705, clientWidth: 1_265 },
    });
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "stream.subscribe" });
    const surfaceId = activeSurfaceId();
    page.cdpSession.emit("Page.screencastFrame", {
      data: jpeg(1_280, 720).toString("base64"),
      metadata: { deviceHeight: 720, deviceWidth: 1_280 },
      sessionId: 1,
    });
    await flushMicrotasks();
    expect(sink.frames.at(-1)?.header).toMatchObject({
      viewportHeight: 720,
      viewportWidth: 1_280,
    });
    await controller.handle({
      action: "move",
      button: "none",
      surfaceId,
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.5,
      y: 0.5,
    });
    // A layout change inside the page never retargets input on its own.
    page.cdpSession.emit("Page.frameResized", {});
    await flushMicrotasks();
    await controller.handle({
      action: "move",
      button: "none",
      surfaceId,
      type: "input.pointer",
      viewportHeight: 705,
      viewportWidth: 1_265,
      x: 0.5,
      y: 0.5,
    });

    expect(
      commandsNamed("Input.dispatchMouseEvent", page).map((entry) => entry.parameters),
    ).toEqual([expect.objectContaining({ x: 640, y: 360 })]);
    // Emulated streams use the ledger's viewport without native-density reads.
    expect(commandsNamed("Page.getLayoutMetrics", page)).toHaveLength(0);
    expect(commandsNamed("Emulation.setDeviceMetricsOverride", page)).toHaveLength(1);
    await controller.close();
    await ledger.close();
  });

  it("sizes only the page a Fit names and starts a person's tab at the size they ask for", async () => {
    const controller = createController();
    await controller.start();
    const rootSurfaceId = activeSurfaceId();

    await controller.handle({
      height: 600,
      surfaceId: rootSurfaceId,
      type: "viewport.set",
      width: 900,
    });
    expect(command("Emulation.setDeviceMetricsOverride", page)?.parameters).toEqual({
      deviceScaleFactor: 1,
      height: 600,
      mobile: false,
      screenHeight: 1_080,
      screenWidth: 1_920,
      width: 900,
    });

    await controller.handle({ type: "surface.open", viewport: { height: 700, width: 1_000 } });
    const opened = context.pages().at(-1);
    if (!(opened instanceof FakePage) || opened === page) throw new Error("Missing opened page");
    expect(commandsNamed("Emulation.setDeviceMetricsOverride", opened)).toEqual([
      expect.objectContaining({
        parameters: expect.objectContaining({ height: 700, width: 1_000 }),
      }),
    ]);
    await controller.handle({ type: "surface.open" });
    const unsized = context.pages().at(-1);
    if (!(unsized instanceof FakePage) || unsized === opened) throw new Error("Missing page");
    // A tab opened without a size starts at the size the person's view last
    // followed; a Fit or a sized tab names one page and never moves it.
    expect(command("Emulation.setDeviceMetricsOverride", unsized)?.parameters).toMatchObject({
      height: 720,
      width: 1_280,
    });

    // A Fit to the size a page already shows, with no agent size over it,
    // writes nothing, and a Fit never touches another page.
    await controller.handle({
      height: 600,
      surfaceId: rootSurfaceId,
      type: "viewport.set",
      width: 900,
    });
    expect(commandsNamed("Emulation.setDeviceMetricsOverride", page)).toHaveLength(2);
    expect(commandsNamed("Emulation.setDeviceMetricsOverride", opened)).toHaveLength(1);
    expect(commandsNamed("Emulation.setDeviceMetricsOverride", unsized)).toHaveLength(1);
    await controller.close();
    await ledger.close();
  });

  it("lets agent metrics size their target and maps clear to that page's own size", async () => {
    const controller = createController();
    await controller.start();
    const surfaceId = activeSurfaceId();
    await controller.handle({ height: 600, surfaceId, type: "viewport.set", width: 900 });

    const targetId = await page.targetId();
    await controller.handle({
      command: { method: "Target.attachToTarget", parameters: { targetId } },
      requestId: "00000000-0000-4000-8000-000000000301",
      type: "cdp.command",
    });
    const attached = sink.messages.find(
      (message) =>
        message.type === "cdp.result" &&
        message.requestId === "00000000-0000-4000-8000-000000000301",
    );
    if (!attached || attached.type !== "cdp.result") throw new Error("Missing attach result");
    const sessionId = (attached.result as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") throw new Error("Missing attached session ID");
    expect(attached.result).toMatchObject({ surfaceId: ledger.active()?.surface.id });

    await controller.handle({
      command: {
        method: "Emulation.setDeviceMetricsOverride",
        parameters: { deviceScaleFactor: 1, height: 400, mobile: false, width: 500 },
        sessionId,
      },
      requestId: "00000000-0000-4000-8000-000000000302",
      type: "cdp.command",
    });
    expect(command("Emulation.setDeviceMetricsOverride", page)?.parameters).toMatchObject({
      height: 400,
      width: 500,
    });

    await controller.handle({
      command: { method: "Emulation.clearDeviceMetricsOverride", sessionId },
      requestId: "00000000-0000-4000-8000-000000000303",
      type: "cdp.command",
    });
    expect(command("Emulation.setDeviceMetricsOverride", page)?.parameters).toEqual({
      deviceScaleFactor: 1,
      height: 600,
      mobile: false,
      screenHeight: 1_080,
      screenWidth: 1_920,
      width: 900,
    });
    expect(commandsNamed("Emulation.clearDeviceMetricsOverride", page)).toHaveLength(0);

    await controller.close();
    await ledger.close();
  });

  it("keeps agent target creation and activation independent from the viewed surface", async () => {
    const controller = createController();
    await controller.start();

    await controller.handle({
      command: { method: "Target.createTarget", parameters: { url: "about:blank" } },
      requestId: "00000000-0000-4000-8000-000000000311",
      type: "cdp.command",
    });
    const created = sink.messages.find(
      (message) =>
        message.type === "cdp.result" &&
        message.requestId === "00000000-0000-4000-8000-000000000311",
    );
    if (!created || created.type !== "cdp.result") throw new Error("Missing create result");
    const secondTargetId = (created.result as { targetId?: unknown }).targetId;
    if (typeof secondTargetId !== "string") throw new Error("Missing created target ID");
    expect(ledger.active()?.targetId).toBe(await page.targetId());

    const rootTargetId = await page.targetId();
    await controller.handle({
      command: { method: "Target.activateTarget", parameters: { targetId: rootTargetId } },
      requestId: "00000000-0000-4000-8000-000000000312",
      type: "cdp.command",
    });
    expect(ledger.active()?.targetId).toBe(rootTargetId);

    await controller.handle({
      command: { method: "Target.attachToTarget", parameters: { targetId: secondTargetId } },
      requestId: "00000000-0000-4000-8000-000000000313",
      type: "cdp.command",
    });
    const attached = sink.messages.find(
      (message) =>
        message.type === "cdp.result" &&
        message.requestId === "00000000-0000-4000-8000-000000000313",
    );
    if (!attached || attached.type !== "cdp.result") throw new Error("Missing attach result");
    const sessionId = (attached.result as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") throw new Error("Missing attached session ID");

    await controller.handle({
      command: { method: "Page.bringToFront", sessionId },
      requestId: "00000000-0000-4000-8000-000000000314",
      type: "cdp.command",
    });
    expect(ledger.active()?.targetId).toBe(rootTargetId);

    const events: SurfaceLedgerEvent[] = [];
    const unsubscribe = ledger.subscribe((event) => events.push(event));
    await controller.handle({
      command: { method: "Page.bringToFront", sessionId },
      requestId: "00000000-0000-4000-8000-000000000315",
      type: "cdp.command",
    });
    expect(events).toEqual([]);
    unsubscribe();
    await controller.close();
    await ledger.close();
  });

  it("silently drops input from a frame whose viewport is stale", async () => {
    const controller = createController();
    await controller.start();
    // The person's view resized the page; input aimed at a frame of the old
    // size names another spot and is dropped.
    await controller.handle({
      height: 600,
      surfaceId: activeSurfaceId(),
      type: "viewport.follow",
      width: 800,
    });
    await controller.handle({
      action: "move",
      button: "none",
      surfaceId: activeSurfaceId(),
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.5,
      y: 0.5,
    });
    await controller.handle({
      deltaX: 0,
      deltaY: 20,
      surfaceId: activeSurfaceId(),
      type: "input.wheel",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.5,
      y: 0.5,
    });

    expect(commandsNamed("Input.dispatchMouseEvent", page)).toHaveLength(0);
    expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(0);
    await controller.close();
    await ledger.close();
  });

  it("ends a held pointer gesture before another viewer resizes", async () => {
    const controller = createController();
    await controller.start();
    const surfaceId = activeSurfaceId();
    await controller.handle({
      action: "down",
      button: "left",
      surfaceId,
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.25,
      y: 0.25,
    });

    await controller.handle({ height: 600, surfaceId, type: "viewport.set", width: 900 });
    const pointerEvents = commandsNamed("Input.dispatchMouseEvent", page).map(
      (entry) => entry.parameters,
    );
    expect(pointerEvents.slice(0, 2)).toEqual([
      expect.objectContaining({ button: "left", buttons: 1, type: "mousePressed" }),
      expect.objectContaining({
        button: "left",
        buttons: 0,
        type: "mouseReleased",
        x: 320,
        y: 180,
      }),
    ]);

    // The first viewer can still send its old pointer-up, but the gesture is
    // already over, so the release names a button no longer held and is
    // dropped without disturbing the controller's cleared held state.
    await controller.handle({
      action: "up",
      button: "left",
      surfaceId,
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.25,
      y: 0.25,
    });
    await controller.handle({
      action: "move",
      button: "none",
      surfaceId,
      type: "input.pointer",
      viewportHeight: 600,
      viewportWidth: 900,
      x: 0.5,
      y: 0.5,
    });
    expect(command("Input.dispatchMouseEvent", page)?.parameters).toMatchObject({
      button: "none",
      buttons: 0,
      type: "mouseMoved",
    });
    expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(0);
    await controller.close();
    await ledger.close();
  });

  it("silently drops keys and pastes aimed at a surface that is no longer active", async () => {
    const controller = createController();
    await controller.start();
    const originalSurfaceId = activeSurfaceId();
    await controller.handle({ type: "surface.open" });
    await flushMicrotasks();
    expect(activeSurfaceId()).not.toBe(originalSurfaceId);

    await controller.handle({
      action: "down",
      code: "KeyA",
      key: "a",
      modifiers: [],
      surfaceId: originalSurfaceId,
      type: "input.key",
    });
    await controller.handle({
      surfaceId: originalSurfaceId,
      text: "pasted",
      type: "clipboard.paste",
    });

    const opened = context.pages().at(-1);
    if (!(opened instanceof FakePage) || opened === page) throw new Error("Missing opened page");
    expect(commandsNamed("Input.dispatchKeyEvent", page)).toHaveLength(0);
    expect(commandsNamed("Input.dispatchKeyEvent", opened)).toHaveLength(0);
    expect(commandsNamed("Input.insertText", page)).toHaveLength(0);
    expect(commandsNamed("Input.insertText", opened)).toHaveLength(0);
    expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(0);
    await controller.close();
    await ledger.close();
  });

  it("drops a release for a button this session never saw pressed", async () => {
    const controller = createController();
    await controller.start();
    await controller.handle({
      action: "up",
      button: "left",
      surfaceId: activeSurfaceId(),
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.5,
      y: 0.5,
    });

    expect(commandsNamed("Input.dispatchMouseEvent", page)).toHaveLength(0);
    expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(0);
    await controller.close();
    await ledger.close();
  });

  it("releases a held press on the page that took it when the person opens another tab", async () => {
    const controller = createController();
    await controller.start();
    await controller.handle({
      action: "down",
      button: "left",
      surfaceId: activeSurfaceId(),
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.25,
      y: 0.25,
    });
    await controller.handle({ type: "surface.open" });
    await flushMicrotasks();
    const opened = context.pages().at(-1);
    if (!(opened instanceof FakePage) || opened === page) throw new Error("Missing opened page");
    expect(activeSurfaceId()).not.toBe(ledger.snapshot()[0]?.id);

    // Sizing the new tab never reaches the page that took the press.
    await controller.handle({
      height: 600,
      surfaceId: activeSurfaceId(),
      type: "viewport.set",
      width: 900,
    });

    expect(
      commandsNamed("Input.dispatchMouseEvent", page).map((entry) => entry.parameters),
    ).toEqual([
      expect.objectContaining({ button: "left", buttons: 1, type: "mousePressed" }),
      expect.objectContaining({
        button: "left",
        buttons: 0,
        type: "mouseReleased",
        x: 320,
        y: 180,
      }),
    ]);
    expect(commandsNamed("Input.dispatchMouseEvent", opened)).toHaveLength(0);
    expect(sink.messages.filter((message) => message.type === "browser.error")).toHaveLength(0);
    await controller.close();
    await ledger.close();
  });

  it("dispatches editing keys with virtual key codes so they act without generated text", async () => {
    const controller = createController();
    await controller.start();
    const surfaceId = activeSurfaceId();
    const keyEvents: BrowserClientMessage[] = [
      {
        action: "down",
        code: "Backspace",
        key: "Backspace",
        modifiers: [],
        surfaceId,
        type: "input.key",
      },
      {
        action: "up",
        code: "Backspace",
        key: "Backspace",
        modifiers: [],
        surfaceId,
        type: "input.key",
      },
      {
        action: "down",
        code: "Enter",
        key: "Enter",
        modifiers: [],
        surfaceId,
        type: "input.key",
      },
      {
        action: "down",
        code: "KeyA",
        key: "a",
        modifiers: [],
        surfaceId,
        text: "a",
        type: "input.key",
      },
    ];
    for (const event of keyEvents) await controller.handle(event);

    const dispatched = commandsNamed("Input.dispatchKeyEvent", page).map(
      (entry) => entry.parameters,
    );
    expect(dispatched).toEqual([
      expect.objectContaining({
        key: "Backspace",
        type: "rawKeyDown",
        windowsVirtualKeyCode: 8,
      }),
      expect.objectContaining({ key: "Backspace", type: "keyUp", windowsVirtualKeyCode: 8 }),
      expect.objectContaining({
        key: "Enter",
        text: "\r",
        type: "keyDown",
        windowsVirtualKeyCode: 13,
      }),
      expect.objectContaining({ key: "a", text: "a", type: "keyDown", windowsVirtualKeyCode: 65 }),
    ]);
    await controller.close();
    await ledger.close();
  });

  it("changes targeted raster demand while retaining a drag and authoritative geometry", async () => {
    const controller = createController();
    await controller.start();
    const surfaceId = activeSurfaceId();
    try {
      await controller.handle({ type: "stream.subscribe", surfaceId });
      const geometry = { ...ledger.active()!.surface };
      const point = { surfaceId, viewportWidth: 1280, viewportHeight: 720, x: 0.25, y: 0.25 };
      await controller.handle({ type: "input.pointer", action: "down", button: "left", ...point });
      await controller.handle({ type: "stream.demand", surfaceId, density: 0.75 });
      expect(command("Page.startScreencast", page)?.parameters).toMatchObject({
        maxWidth: 960,
        maxHeight: 540,
      });
      expect(ledger.active()!.surface).toEqual(geometry);
      expect(commandsNamed("Emulation.setDeviceMetricsOverride", page)).toHaveLength(1);
      await controller.handle({ type: "input.pointer", action: "move", button: "none", ...point });
      expect(command("Input.dispatchMouseEvent", page)?.parameters).toMatchObject({
        type: "mouseMoved",
        button: "left",
        buttons: 1,
        x: 320,
        y: 180,
      });
      page.cdpSession.emit("Page.screencastFrame", {
        data: jpeg(960, 540).toString("base64"),
        metadata: { deviceHeight: 720, deviceWidth: 1280 },
        sessionId: 1,
      });
      await flushMicrotasks();
      expect(sink.frames.at(-1)?.header).toMatchObject({
        viewportWidth: 1280,
        viewportHeight: 720,
        rasterWidth: 960,
        rasterHeight: 540,
      });
      const starts = commandsNamed("Page.startScreencast", page).length;
      await controller.handle({ type: "stream.demand", surfaceId, density: 0.75 });
      expect(commandsNamed("Page.startScreencast", page)).toHaveLength(starts);
      await controller.handle({ type: "input.pointer", action: "up", button: "left", ...point });
      expect(command("Input.dispatchMouseEvent", page)?.parameters).toMatchObject({
        type: "mouseReleased",
        button: "left",
        buttons: 0,
      });
    } finally {
      await controller.close();
      await ledger.close();
    }
  });

  it("names the held button on moves so drags select text instead of hovering", async () => {
    const controller = createController();
    await controller.start();
    const point = {
      surfaceId: activeSurfaceId(),
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.25,
      y: 0.25,
    } as const;
    await controller.handle({ action: "down", button: "left", type: "input.pointer", ...point });
    await controller.handle({
      action: "move",
      button: "none",
      surfaceId: activeSurfaceId(),
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.5,
      y: 0.5,
    });
    await controller.handle({ action: "up", button: "left", type: "input.pointer", ...point });
    await controller.handle({
      action: "move",
      button: "none",
      surfaceId: activeSurfaceId(),
      type: "input.pointer",
      viewportHeight: 720,
      viewportWidth: 1_280,
      x: 0.75,
      y: 0.75,
    });

    const moves = commandsNamed("Input.dispatchMouseEvent", page)
      .map((entry) => entry.parameters)
      .filter((parameters) => parameters?.type === "mouseMoved");
    expect(moves).toEqual([
      expect.objectContaining({ button: "left", buttons: 1 }),
      expect.objectContaining({ button: "none", buttons: 0 }),
    ]);
    await controller.close();
    await ledger.close();
  });

  it("publishes the page selection when a copy or cut chord reaches the browser", async () => {
    const controller = createController();
    await controller.start();
    const surfaceId = activeSurfaceId();
    page.cdpSession.responses.set("Runtime.evaluate", { result: { value: "selected words" } });
    const chord = (key: string, modifiers: Array<"alt" | "control" | "meta" | "shift">) =>
      controller.handle({
        action: "down" as const,
        code: `Key${key.toUpperCase()}`,
        key,
        modifiers,
        surfaceId,
        type: "input.key" as const,
      });

    await chord("c", ["meta"]);
    await chord("x", ["control"]);
    // Not copy chords: plain key, shifted chord, and keyup must stay silent.
    await chord("c", []);
    await chord("c", ["meta", "shift"]);
    await controller.handle({
      action: "up",
      code: "KeyC",
      key: "c",
      modifiers: ["meta"],
      surfaceId,
      type: "input.key",
    });

    const published = sink.messages.filter((message) => message.type === "clipboard.data");
    expect(published).toEqual([
      expect.objectContaining({ text: "selected words" }),
      expect.objectContaining({ text: "selected words" }),
    ]);
    // The chord still reaches the page even while the selection is captured.
    expect(
      commandsNamed("Input.dispatchKeyEvent", page).filter(
        (entry) => entry.parameters?.type !== "keyUp",
      ),
    ).toHaveLength(4);

    page.cdpSession.responses.set("Runtime.evaluate", { result: { value: "" } });
    await chord("c", ["meta"]);
    expect(sink.messages.filter((message) => message.type === "clipboard.data")).toHaveLength(2);
    await controller.close();
    await ledger.close();
  });

  it("translates the Meta chord to Control when the engine runs on a Control-primary OS", async () => {
    const controller = new BrowserController({
      cdpRouter,
      claims: validClaims(),
      files,
      ledger,
      replaceSiteCookies,
      platform: "linux",
      signIns: noSignIns(),
      sink,
    });
    await controller.start();
    await controller.handle({
      action: "down",
      code: "KeyA",
      key: "a",
      modifiers: ["meta"],
      surfaceId: activeSurfaceId(),
      type: "input.key",
    });
    expect(command("Input.dispatchKeyEvent", page)?.parameters).toMatchObject({ modifiers: 2 });
    await controller.close();
    await ledger.close();
  });

  it("opens a new surface on demand and navigates it when a URL is provided", async () => {
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "surface.open" });
    await flushMicrotasks();
    expect(ledger.snapshot()).toEqual([
      expect.objectContaining({ active: false, title: "Controlled" }),
      expect.objectContaining({ active: true }),
    ]);

    await controller.handle({
      type: "surface.open",
      url: "https://opensteer.com/fresh",
    });
    await flushMicrotasks();
    const surfaces = ledger.snapshot();
    expect(surfaces).toHaveLength(3);
    const opened = surfaces.at(-1);
    expect(opened).toMatchObject({ active: true });
    const binding = opened ? ledger.binding(opened.id) : null;
    if (!binding) throw new Error("Missing opened surface binding");
    const navigated = (binding.page as FakePage).cdpSession.sent.find(
      (entry) => entry.method === "Page.navigate",
    );
    expect(navigated?.parameters).toEqual({ url: "https://opensteer.com/fresh" });

    await controller.handle({ type: "surface.open", url: "file:///etc/passwd" });
    const errors = sink.messages.filter((message) => message.type === "browser.error");
    expect(errors.map((message) => message.error.code)).toEqual(["forbidden"]);
    await controller.close();
    await ledger.close();
  });

  it("preserves raw CDP commands, attached-session IDs, and streamed events", async () => {
    const controller = createController();
    await controller.start();
    const targetId = await page.targetId();
    const settleTarget = vi.spyOn(ledger, "settleTarget");
    const attachRequestId = "00000000-0000-4000-8000-000000000101";
    await controller.handle({
      command: { method: "Target.attachToTarget", parameters: { targetId } },
      requestId: attachRequestId,
      type: "cdp.command",
    });
    const attached = sink.messages.find(
      (message) => message.type === "cdp.result" && message.requestId === attachRequestId,
    );
    if (!attached || attached.type !== "cdp.result") throw new Error("Missing CDP attach result");
    expect(settleTarget).toHaveBeenCalledWith(targetId);
    const sessionId = (attached.result as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") throw new Error("Missing virtual CDP session ID");

    await controller.handle({
      command: {
        method: "Page.navigate",
        parameters: { url: "https://example.test/raw" },
        sessionId,
      },
      requestId: "00000000-0000-4000-8000-000000000102",
      type: "cdp.command",
    });
    expect(command("Page.navigate", page)?.parameters).toEqual({
      url: "https://example.test/raw",
    });

    page.cdpSession.emit("Page.loadEventFired", { timestamp: 1 });
    await flushMicrotasks();
    expect(sink.messages.at(-1)).toMatchObject({
      event: { method: "Page.loadEventFired", parameters: { timestamp: 1 }, sessionId },
      type: "cdp.event",
    });
    await controller.close();
    await ledger.close();
  });

  it("does not reorder the agent's target inventory when the person changes tabs", async () => {
    const controller = createController();
    await controller.start();
    const createRequestId = "00000000-0000-4000-8000-000000000201";
    await controller.handle({
      command: { method: "Target.createTarget", parameters: { url: "about:blank" } },
      requestId: createRequestId,
      type: "cdp.command",
    });
    const created = sink.messages.find(
      (message) => message.type === "cdp.result" && message.requestId === createRequestId,
    );
    if (!created || created.type !== "cdp.result") throw new Error("Missing target create result");
    const targetId = (created.result as { targetId?: unknown }).targetId;
    if (typeof targetId !== "string") throw new Error("Missing created target ID");
    await flushMicrotasks();
    const second = ledger.snapshot().find((surface) => surface.url === "about:blank");
    if (!second) throw new Error("Missing created surface");
    await controller.handle({ type: "surface.activate", surfaceId: second.id });
    expect(ledger.snapshot()).toEqual([
      expect.objectContaining({ active: false, title: "Controlled" }),
      expect.objectContaining({ active: true, url: "about:blank" }),
    ]);

    const listRequestId = "00000000-0000-4000-8000-000000000202";
    await controller.handle({
      command: { method: "Target.getTargets" },
      requestId: listRequestId,
      type: "cdp.command",
    });
    const listed = sink.messages.find(
      (message) => message.type === "cdp.result" && message.requestId === listRequestId,
    );
    if (!listed || listed.type !== "cdp.result") throw new Error("Missing target list result");
    const targetInfos = (listed.result as { targetInfos?: unknown }).targetInfos;
    expect(Array.isArray(targetInfos) ? targetInfos[0] : null).toMatchObject({
      targetId: await page.targetId(),
    });
    await controller.close();
    await ledger.close();
  });

  it("delivers ordered human input while an agent command is still running", async () => {
    const controller = createController();
    await controller.start();
    const evaluation = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    const send = vi.spyOn(cdpRouter, "send");
    send.mockImplementationOnce(async () => {
      entered.resolve();
      return evaluation.promise;
    });
    const pending = controller.handle({
      command: { method: "Runtime.evaluate", parameters: { expression: "slow()" } },
      requestId: "00000000-0000-4000-8000-000000000221",
      type: "cdp.command",
    });
    await entered.promise;
    const active = ledger.active();
    if (!active) throw new Error("Missing active surface");
    const typing = controller.handle({
      type: "input.key",
      surfaceId: active.surface.id,
      code: "KeyX",
      key: "x",
      action: "down",
      modifiers: [],
    });
    await flushMicrotasks();
    expect(commandsNamed("Input.dispatchKeyEvent", page)).toHaveLength(1);
    expect(sink.messages.some((message) => message.type === "cdp.result")).toBe(false);
    evaluation.resolve({});
    await Promise.all([pending, typing]);
    await controller.close();
    await ledger.close();
  });

  it("reports only the latest human action on its exact target without typed content", async () => {
    const controller = createController();
    await controller.start();
    const active = ledger.active();
    if (!active) throw new Error("Missing active surface");
    await controller.handle({
      type: "clipboard.paste",
      surfaceId: active.surface.id,
      text: "never-include-this-secret-in-activity",
    });
    await controller.handle({
      command: {
        method: "Target.getTargetInfo",
        parameters: { targetId: await page.targetId() },
      },
      requestId: "00000000-0000-4000-8000-000000000222",
      type: "cdp.command",
    });
    const result = sink.messages.find(
      (message) => message.type === "cdp.result" && message.requestId.endsWith("222"),
    );
    if (!result || result.type !== "cdp.result") throw new Error("Missing target info");
    expect(result.result).toMatchObject({
      targetInfo: {
        targetId: await page.targetId(),
        userActivity: { kind: "typing", at: expect.any(String) },
      },
    });
    expect(JSON.stringify(result.result)).not.toContain("never-include-this-secret");
    await controller.close();
    await ledger.close();
  });

  it("clears a dialog before publishing a different active surface", async () => {
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "surface.open" });
    await flushMicrotasks();
    const original = ledger.snapshot().find((surface) => surface.title === "Controlled");
    const opened = ledger.snapshot().find((surface) => surface.active);
    const openedBinding = opened ? ledger.binding(opened.id) : null;
    if (!original || !openedBinding) throw new Error("Missing test surfaces");

    (openedBinding.page as FakePage).cdpSession.emit("Page.javascriptDialogOpening", {
      message: "Stay here?",
      type: "confirm",
    });
    await flushMicrotasks();
    const switchMessagesStart = sink.messages.length;
    await controller.handle({
      surfaceId: original.id,
      type: "surface.activate",
    });
    await flushMicrotasks();

    expect(
      sink.messages
        .slice(switchMessagesStart)
        .filter(
          (message) =>
            message.type === "browser.dialog.changed" ||
            message.type === "browser.surfaces.changed",
        )
        .map((message) =>
          message.type === "browser.dialog.changed"
            ? `${message.type}:${message.dialog === null ? "cleared" : "open"}`
            : message.type,
        ),
    ).toEqual(["browser.dialog.changed:cleared", "browser.surfaces.changed"]);
    await controller.close();
    await ledger.close();
  });

  it("rejects malformed frames, unsafe navigation, and oversized streams", async () => {
    const controller = createController();
    await controller.start();
    await controller.handle({ type: "stream.subscribe" });
    await controller.handleRaw("not-json");
    await controller.handleRaw(JSON.stringify({ type: "unknown" }));
    await controller.handle({ type: "navigation.go", url: "file:///etc/passwd" });
    await controller.handleRaw(
      JSON.stringify({
        action: "down",
        button: "left",
        type: "input.pointer",
        x: 0.5,
        y: 0.5,
      }),
    );

    const errors = sink.messages.filter((message) => message.type === "browser.error");
    expect(errors.map((message) => message.error.code)).toEqual([
      "bad_message",
      "bad_message",
      "forbidden",
      "bad_message",
    ]);
    expect(commandsNamed("Page.navigate", page)).toHaveLength(0);
    await controller.close();
    await controller.close();
    expect(commandsNamed("Page.stopScreencast", page)).toHaveLength(1);
    await ledger.close();
  });

  it("finishes admitted commands before publishing terminal lifecycle state", async () => {
    let releaseNavigation: () => void = () => undefined;
    const navigation = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    page.cdpSession.responses.set("Page.navigate", async () => navigation);
    const controller = createController();
    await controller.start();
    const navigationRequest = controller.handle({
      type: "navigation.go",
      url: "https://example.test/slow",
    });
    await flushMicrotasks();
    expect(command("Page.navigate", page)).toBeDefined();
    const reloadRequest = controller.handle({ type: "navigation.reload" });

    const closing = controller.close();
    await flushMicrotasks();
    expect(sink.messages.some((message) => message.type === "browser.status")).toBe(false);
    releaseNavigation();
    await navigationRequest;
    await reloadRequest;
    await closing;

    expect(command("Page.reload", page)).toBeDefined();
    expect(
      sink.messages
        .filter((message) => message.type === "browser.status")
        .map((message) => `${message.type}:${message.state}`),
    ).toEqual(["browser.status:closing", "browser.status:closed"]);
    await ledger.close();
  });

  it("bounds surface command admission and correlates each refusal", async () => {
    let releaseNavigation: () => void = () => undefined;
    const navigation = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    page.cdpSession.responses.set("Page.navigate", async () => navigation);
    const controller = createController(1);
    await controller.start();

    const activeCommand = controller.handle({
      type: "navigation.go",
      url: "https://opensteer.com/slow",
    });
    const waiting = controller.handle({ type: "navigation.reload", inputSequence: 1 });
    await controller.handle({ type: "navigation.reload", inputSequence: 2 });
    await controller.handle({ type: "navigation.reload", inputSequence: 3 });
    const overloads = sink.messages.filter(
      (message) => message.type === "browser.error" && message.error.code === "conflict",
    );
    expect(overloads).toMatchObject([
      { inputSequence: 2, error: { reason: "browser-input-overload" } },
      { inputSequence: 3, error: { reason: "browser-input-overload" } },
    ]);

    releaseNavigation();
    await Promise.all([activeCommand, waiting]);
    await controller.close();
    await ledger.close();
  });

  it.each(["address", "initial", "tab-open"] as const)(
    "refuses unnegotiated attribution for %s navigation and keeps baseline navigation available",
    async (path) => {
      const controller = createController();
      await controller.start();
      const url = "https://person.test/";
      const navigationId = globalThis.crypto.randomUUID();
      try {
        expect(
          sink.messages.find((message) => message.type === "browser.snapshot"),
        ).not.toHaveProperty("navigationAttributionVersion");
        if (path === "address")
          await controller.handle({ type: "navigation.go", url, navigationId });
        else {
          const attached = await cdpRouter.send(validClaims().sessionId, {
            method: "Target.attachToTarget",
            parameters: { targetId: await page.targetId(), flatten: true },
          });
          const { sessionId } = attached as { sessionId: string };
          await controller.handle({
            type: "cdp.command",
            requestId: globalThis.crypto.randomUUID(),
            navigationId,
            command:
              path === "initial"
                ? { method: "Page.navigate", sessionId, parameters: { url } }
                : {
                    method: browserHostMethods.openTab,
                    parameters: { idempotencyKey: "unnegotiated-open", url },
                  },
          });
        }
        expect(sink.messages).toContainEqual(
          expect.objectContaining({
            type: "browser.error",
            error: expect.objectContaining({ code: "forbidden" }),
          }),
        );
        expect(commandsNamed("Page.navigate", page)).toHaveLength(0);
        await controller.handle({ type: "navigation.go", url });
        expect(commandsNamed("Page.navigate", page)).toHaveLength(1);
        // A ledger attribution must not escape a session admitted by an older Host.
        page.cdpSession.responses.set("Page.navigate", () => {
          page.cdpSession.emit("Page.frameNavigated", {
            frame: { id: "main", loaderId: "person-loader", url },
          });
          return { loaderId: "person-loader" };
        });
        await ledger.navigate(activeSurfaceId(), url, navigationId);
        await flushMicrotasks();
        expect(sink.messages.some((message) => message.type === "navigation.committed")).toBe(
          false,
        );
      } finally {
        await controller.close();
        await ledger.close();
      }
    },
  );

  it.each(
    (["address", "initial", "tab-open"] as const).flatMap((path) =>
      (["reply-first", "commit-first", "push-state", "redirect"] as const).map((ordering) => ({
        path,
        ordering,
      })),
    ),
  )("uses browser attribution for $path navigation ($ordering)", async ({ path, ordering }) => {
    const controller = createController(
      undefined,
      {},
      validClaims({ navigationAttributionVersion: 1 }),
    );
    await controller.start();
    expect(sink.messages.find((message) => message.type === "browser.snapshot")).toHaveProperty(
      "navigationAttributionVersion",
      1,
    );
    const navigationId = globalThis.crypto.randomUUID();
    const url = "https://person.test/";
    let navigatedPage = page;
    if (path === "tab-open") {
      const nextPage = new FakePage();
      vi.spyOn(context, "createPage").mockImplementation(async () => {
        context.addPage(nextPage);
        return nextPage;
      });
      navigatedPage = nextPage;
    }
    const frameId = await navigatedPage.targetId();
    const commit = () =>
      navigatedPage.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", loaderId: "person-loader", url: "https://redirect.test/" },
      });
    navigatedPage.cdpSession.responses.set("Page.navigate", () => {
      if (ordering !== "reply-first") {
        commit();
        if (ordering === "push-state")
          navigatedPage.cdpSession.emit("Page.navigatedWithinDocument", {
            frameId,
            url: "https://redirect.test/agent-route",
            navigationType: "historyApi",
          });
        if (ordering === "redirect") navigatedPage.navigate("https://agent.test/", "Agent");
      }
      return { loaderId: "person-loader" };
    });
    try {
      if (path === "address") await controller.handle({ type: "navigation.go", url, navigationId });
      else if (path === "tab-open")
        await controller.handle({
          type: "cdp.command",
          requestId: globalThis.crypto.randomUUID(),
          navigationId,
          command: {
            method: browserHostMethods.openTab,
            parameters: { idempotencyKey: "attributed-open", url },
          },
        });
      else {
        const attached = await cdpRouter.send(validClaims().sessionId, {
          method: "Target.attachToTarget",
          parameters: { targetId: await page.targetId(), flatten: true },
        });
        const { sessionId } = attached as { sessionId: string };
        await controller.handle({
          type: "cdp.command",
          requestId: globalThis.crypto.randomUUID(),
          navigationId,
          command: { method: "Page.navigate", sessionId, parameters: { url } },
        });
      }
      if (ordering === "reply-first") commit();
      // No microtask gap: snapshot coalescing may omit the committed document.
      navigatedPage.navigate("https://agent.test/", "Agent");
      await flushMicrotasks();
      expect(sink.messages.filter((message) => message.type === "navigation.committed")).toEqual([
        expect.objectContaining({
          navigationId,
          url: "https://redirect.test/",
          documentId: expect.any(String),
          surfaceId: expect.any(String),
        }),
      ]);
      expect(
        ledger.snapshot().find((surface) => surface.url === "https://agent.test/"),
      ).not.toHaveProperty("navigationId");
      if (path === "tab-open") {
        const before = navigatedPage.cdpSession.sent.filter(
          (command) => command.method === "Page.navigate",
        ).length;
        await controller.handle({
          type: "cdp.command",
          requestId: globalThis.crypto.randomUUID(),
          navigationId: globalThis.crypto.randomUUID(),
          command: {
            method: browserHostMethods.openTab,
            parameters: { idempotencyKey: "attributed-open", url },
          },
        });
        expect(
          navigatedPage.cdpSession.sent.filter((command) => command.method === "Page.navigate"),
        ).toHaveLength(before);
      }
    } finally {
      await controller.close();
      await ledger.close();
    }
  });

  it("coalesces surface churn to the latest state while the output sink is slow", async () => {
    const controller = createController();
    await controller.start();
    let releaseSlowSend: () => void = () => undefined;
    const slowSend = new Promise<void>((resolve) => {
      releaseSlowSend = resolve;
    });
    let blocked = true;
    sink.sendServerImplementation = async (message) => {
      if (blocked && message.type === "browser.surfaces.changed") await slowSend;
    };

    page.setMetadata("Update 0", "https://example.test/update-0");
    await flushMicrotasks();
    for (let index = 1; index <= 100; index += 1) {
      page.setMetadata(`Update ${index}`, `https://example.test/update-${index}`);
      await flushMicrotasks();
    }
    expect(
      sink.messages.filter((message) => message.type === "browser.surfaces.changed"),
    ).toHaveLength(1);

    blocked = false;
    releaseSlowSend();
    await flushMicrotasks();
    await flushMicrotasks();
    const snapshots = sink.messages.filter(
      (message) => message.type === "browser.surfaces.changed",
    );
    expect(snapshots).toHaveLength(2);
    expect(snapshots.at(-1)).toMatchObject({
      surfaces: [expect.objectContaining({ url: "https://example.test/update-100" })],
    });
    await controller.close();
    await ledger.close();
  });

  it("bounds non-coalescible output queued behind a slow sink", async () => {
    const controller = createController(undefined, {
      maxPendingMessages: 2,
    });
    await controller.start();
    let releaseSlowSend: () => void = () => undefined;
    const slowSend = new Promise<void>((resolve) => {
      releaseSlowSend = resolve;
    });
    let blocked = true;
    sink.sendServerImplementation = async (message) => {
      if (blocked && message.type === "browser.dialog.changed") await slowSend;
    };

    for (let index = 0; index < 100; index += 1) {
      page.cdpSession.emit("Page.javascriptDialogOpening", {
        message: `Dialog ${index}`,
        type: "alert",
      });
    }
    await flushMicrotasks();
    expect(
      sink.messages.filter((message) => message.type === "browser.dialog.changed"),
    ).toHaveLength(1);

    blocked = false;
    releaseSlowSend();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(
      sink.messages.filter((message) => message.type === "browser.dialog.changed"),
    ).toHaveLength(2);
    await controller.close();
    await ledger.close();
  });

  function createController(
    maxPendingCommands?: number,
    outputLimits: { maxPendingMessageBytes?: number; maxPendingMessages?: number } = {},
    claims: BrowserAttachTicketClaims = validClaims(),
  ): BrowserController {
    return new BrowserController({
      cdpRouter,
      claims,
      files,
      ledger,
      replaceSiteCookies,
      ...(maxPendingCommands === undefined ? {} : { maxPendingCommands }),
      ...outputLimits,
      platform: "darwin",
      signIns: noSignIns(),
      sink,
    });
  }

  function activeSurfaceId() {
    const surfaceId = ledger.active()?.surface.id;
    if (!surfaceId) throw new Error("Missing active browser surface");
    return surfaceId;
  }

  describe("page references", () => {
    const candidate = async (controller: BrowserController, surfaceId: string) => {
      const requestId = globalThis.crypto.randomUUID();
      await controller.handle({
        type: "cdp.command",
        requestId,
        command: { method: browserHostMethods.contextCandidate, parameters: { surfaceId } },
      });
      return sink.messages.find(
        (message) =>
          (message.type === "cdp.result" || message.type === "cdp.error") &&
          message.requestId === requestId,
      );
    };
    const started = async () => {
      const controller = new BrowserController({
        cdpRouter,
        claims: validClaims(),
        files,
        ledger,
        replaceSiteCookies,
        platform: "darwin",
        signIns: noSignIns(),
        sink,
      });
      await controller.start();
      for (let turn = 0; turn < 20; turn += 1) await flushMicrotasks();
      return controller;
    };

    it("answers from the ledger without a CDP command, with no title before the document names one", async () => {
      const controller = await started();
      try {
        const surface = ledger.snapshot()[0]!;
        const sent = page.cdpSession.sent.length;
        expect(await candidate(controller, surface.id)).toMatchObject({
          type: "cdp.result",
          result: {
            documentId: surface.documentId,
            title: "Controlled",
            url: "https://example.test",
          },
        });
        // The next document's own title has not been read yet.
        page.cdpSession.responses.set("Runtime.evaluate", () => new Promise(() => undefined));
        page.navigate("https://example.test/next", "Next");
        // Background sampling is not the read's; let it reach its held evaluation.
        for (let turn = 0; turn < 20; turn += 1) await flushMicrotasks();
        const next = ledger.snapshot()[0]!;
        const before = page.cdpSession.sent.length;
        expect(await candidate(controller, surface.id)).toMatchObject({
          type: "cdp.result",
          result: { documentId: next.documentId, title: "", url: "https://example.test/next" },
        });
        expect(page.cdpSession.sent.length).toBe(before);
        expect(sent).toBeLessThanOrEqual(before);
        expect(next.title).toBe("");
      } finally {
        await controller.close();
        await ledger.close();
      }
    });

    it("refuses a page reference while the live address is ahead of the committed document", async () => {
      const controller = await started();
      try {
        const surface = ledger.snapshot()[0]!;
        vi.spyOn(page, "url").mockReturnValue("https://example.test/ahead");
        expect(await candidate(controller, surface.id)).toMatchObject({
          type: "cdp.error",
          error: { code: "conflict" },
        });
      } finally {
        await controller.close();
        await ledger.close();
      }
    });
  });
});

function command(method: string, page: FakePage) {
  return [...page.cdpSession.sent].reverse().find((entry) => entry.method === method);
}

function commandsNamed(method: string, page: FakePage) {
  return page.cdpSession.sent.filter((entry) => entry.method === method);
}

function noSignIns(): HostSignIns {
  return new HostSignIns({
    authority: undefined,
    runtimeId: "test-runtime",
  });
}
