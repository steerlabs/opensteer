import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserSurfaceIdSchema, createBrowserSessionId } from "@opensteer/protocol";
import {
  BrowserActionRequestSchema,
  BrowserActionResponseSchema,
  BrowserActionErrorCodeSchema,
} from "@opensteer/protocol/browser-actions";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error The standalone Harness runs directly as JavaScript.
import { ActionsClient, createActionsHarness } from "./actions.mjs";

const sessionId = createBrowserSessionId();
const binding = {
  surfaceId: BrowserSurfaceIdSchema.parse("tab-1"),
  documentId: "document-1",
  geometryRevision: 4,
  state: "live",
  title: "Order",
  url: "https://shop.test/",
};

class Socket extends EventEmitter {
  tabs = [binding];
  requests: Array<ReturnType<typeof BrowserActionRequestSchema.parse>> = [];
  binding = { ...binding };
  respond = true;
  errorOnce = false;
  errorCode: string | undefined;
  addEventListener(name: string, listener: (...args: unknown[]) => void) {
    this.on(name, listener);
  }
  send(raw: string) {
    const request = BrowserActionRequestSchema.parse(JSON.parse(raw));
    this.requests.push(request);
    if (!this.respond) return;
    let result: unknown;
    switch (request.action.type) {
      case "session.tabs":
        result = { type: request.action.type, tabs: this.tabs };
        break;
      case "surface.attach":
      case "surface.resume":
      case "surface.open":
      case "page.wait":
      case "page.navigate":
        result = { type: request.action.type, binding: this.binding };
        break;
      case "page.info":
        result = {
          type: request.action.type,
          binding: this.binding,
          loading: false,
          navigationFailed: false,
          sizedByAgent: false,
          dialog: null,
        };
        break;
      case "dom.query":
        result = {
          type: request.action.type,
          value: request.action.read === "count" ? 1 : "Ready",
        };
        break;
      case "dom.snapshot":
        result = { type: request.action.type, text: '- button "Pay"' };
        break;
      case "dom.act":
        result = { type: request.action.type, outcome: "acted", trusted: false };
        break;
      case "surface.close":
        result = { type: request.action.type, outcome: "closed" };
        break;
      case "scroll":
        result = { type: request.action.type, x: 0, y: 30, source: "native" };
        break;
      case "file.stage":
        result = {
          type: request.action.type,
          fileId: request.action.fileId,
          complete: request.action.size !== undefined,
        };
        break;
      case "file.choose":
        result = {
          type: request.action.type,
          files: request.action.stagedFileIds.map((fileId) => ({
            fileId,
            name: "receipt.txt",
            size: 3,
          })),
        };
        break;
      case "page.capture":
        result = {
          type: request.action.type,
          format: request.action.format,
          data: "AAAA",
          width: 100,
          height: 100,
          viewport: { width: 100, height: 100 },
        };
        break;
      default:
        result = { type: request.action.type };
    }
    const response = BrowserActionResponseSchema.parse(
      this.errorCode
        ? {
            id: request.id,
            error: {
              code: this.errorCode,
              message: "Refused",
              ...(this.errorCode === "dialog-open"
                ? {
                    dialog: {
                      id: "00000000-0000-4000-8000-000000000001",
                      surfaceId: binding.surfaceId,
                      type: "confirm",
                      message: "Pay?",
                    },
                  }
                : {}),
            },
          }
        : { id: request.id, result },
    );
    if (this.errorOnce) this.errorCode = undefined;
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(response) }));
  }
  close() {
    this.emit("close", { reason: "Ended" });
  }
}

function fixture() {
  const socket = new Socket();
  const client = new ActionsClient(socket, sessionId);
  return { socket, harness: createActionsHarness(client) };
}

describe("actions Harness conformance", () => {
  it("opens the first tab without a target and focuses before pressing or appending", async () => {
    const { socket, harness } = fixture();
    socket.tabs = [];
    await harness.listTabs();
    expect(socket.requests[0]).not.toHaveProperty("surfaceId");
    await harness.newTab("https://first.test/");
    const opened = socket.requests.find((request) => request.action.type === "surface.open");
    expect(opened).not.toHaveProperty("surfaceId");
    expect(opened).not.toHaveProperty("documentId");
    const start = socket.requests.length;
    await harness.page.locator("input").focus();
    await harness.page.locator("input").press("Enter");
    await harness.page.locator("input").press("Backspace");
    await harness.fillInput("input", "tail", { clear: false });
    expect(socket.requests.slice(start).map((request) => request.action)).toEqual([
      { type: "dom.act", locator: { by: "css", value: "input" }, kind: "focus" },
      { type: "dom.act", locator: { by: "css", value: "input" }, kind: "focus" },
      { type: "text.key", key: "Enter" },
      { type: "dom.act", locator: { by: "css", value: "input" }, kind: "focus" },
      { type: "text.key", key: "Backspace" },
      {
        type: "dom.act",
        locator: { by: "css", value: "input", position: "first" },
        kind: "focus",
        selection: "end",
      },
      { type: "text.insert", text: "tail" },
    ]);
  });

  it("wakes a sleeping tab before its first action, however the tab was chosen", async () => {
    const asleep = { ...binding, state: "suspended" as const };
    const chosen = (socket: Socket) =>
      socket.requests
        .filter((request) => request.action.type.startsWith("surface."))
        .map((request) => request.action.type);
    const only = fixture();
    only.socket.tabs = [asleep];
    await only.harness.pageInfo();
    expect(chosen(only.socket)).toEqual(["surface.resume"]);
    await only.harness.pageInfo();
    expect(chosen(only.socket)).toEqual(["surface.resume"]);

    const named = new Socket();
    named.tabs = [asleep];
    await createActionsHarness(new ActionsClient(named, sessionId), asleep.surfaceId).pageInfo();
    expect(chosen(named)).toEqual(["surface.resume"]);
  });

  it("never sends text after an unsuccessful focus or replays an unknown focus outcome", async () => {
    for (const code of ["outcome-unknown", "stale-document", "not-actionable"] as const) {
      const { socket, harness } = fixture();
      await harness.ensureRealTab();
      socket.errorCode = code;
      socket.errorOnce = true;
      const start = socket.requests.length;
      await expect(harness.page.locator("input").press("Enter")).rejects.toMatchObject({ code });
      expect(
        socket.requests.slice(start).filter((request) => request.action.type === "dom.act"),
      ).toHaveLength(1);
      expect(socket.requests.some((request) => request.action.type === "text.key")).toBe(false);
      expect(socket.requests.some((request) => request.action.type === "text.insert")).toBe(false);
    }
  });
  it("maps page operations to the real bounded action schemas", async () => {
    const { socket, harness } = fixture();
    expect(await harness.listTabs()).toMatchObject([{ targetId: binding.surfaceId }]);
    await harness.ensureRealTab();
    await harness.page
      .getByRole("dialog", { name: "Checkout" })
      .getByLabel("Email")
      .first()
      .fill("a@test.com");
    await harness.page
      .locator("button")
      .filter({ hasText: "Pay", visible: true })
      .last()
      .dblclick();
    await harness.page.getByText("Ready").waitFor({ state: "visible", timeout: 200 });
    await harness.page.keyboard.type("hello");
    await harness.page.keyboard.press("Enter");
    await harness.page.mouse.click(10, 20);
    await harness.scroll(0, 0, { deltaY: 30 });
    await harness.page.goto("https://shop.test/next");
    await harness.page.waitForURL("https://shop.test/next");
    await harness.page.ariaSnapshot();
    expect(socket.requests.find((request) => request.action.type === "pointer.tap")).toMatchObject({
      documentId: "document-1",
      geometryRevision: 4,
    });
    expect(socket.requests.find((request) => request.action.type === "dom.act")).toMatchObject({
      action: {
        locator: {
          by: "label",
          value: "Email",
          position: "first",
          scope: { by: "role", value: "dialog", name: "Checkout" },
        },
      },
    });
    expect(
      socket.requests.filter((request) => request.action.type === "page.navigate"),
    ).toHaveLength(1);
  });

  it.each(BrowserActionErrorCodeSchema.options)(
    "preserves %s without replaying input",
    async (code) => {
      const { socket, harness } = fixture();
      await harness.ensureRealTab();
      socket.errorCode = code;
      await expect(harness.page.getByText("Pay").click()).rejects.toMatchObject({ code });
      expect(socket.requests.filter((request) => request.action.type === "dom.act")).toHaveLength(
        1,
      );
    },
  );

  it("refreshes a stale binding for the caller, without replaying the action", async () => {
    const { socket, harness } = fixture();
    await harness.ensureRealTab();
    socket.binding = { ...binding, documentId: "document-2", geometryRevision: 7 };
    socket.errorCode = "stale-document";
    socket.errorOnce = true;
    await expect(harness.page.getByText("Pay").click()).rejects.toMatchObject({
      code: "stale-document",
    });
    expect(socket.requests.filter((request) => request.action.type === "dom.act")).toHaveLength(1);
    expect(socket.requests.at(-1)?.action.type).toBe("surface.attach");
    await harness.page.getByText("Pay").click();
    expect(socket.requests.at(-1)).toMatchObject({
      documentId: "document-2",
      action: { type: "dom.act" },
    });
  });

  it("reports unknown input outcome when the connection closes after submission", async () => {
    const { socket, harness } = fixture();
    await harness.ensureRealTab();
    socket.respond = false;
    const input = harness.page.getByText("Pay").click();
    await vi.waitFor(
      () =>
        expect(socket.requests.at(-1)?.action.type, "The click was never submitted").toBe(
          "dom.act",
        ),
      { timeout: 500 },
    );
    socket.close();
    await expect(input).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(socket.requests.filter((request) => request.action.type === "dom.act")).toHaveLength(1);
  });

  it("interrupts a dialog-blocked action without waiting for its result", async () => {
    const { socket, harness } = fixture();
    await harness.ensureRealTab();
    socket.respond = false;
    const input = harness.page.getByText("Pay").click();
    await vi.waitFor(
      () =>
        expect(socket.requests.at(-1)?.action.type, "The click was never submitted").toBe(
          "dom.act",
        ),
      { timeout: 500 },
    );
    const dialog = {
      id: "00000000-0000-4000-8000-000000000001",
      surfaceId: binding.surfaceId,
      type: "confirm",
      message: "Pay?",
    };
    socket.emit("message", {
      data: JSON.stringify({
        event: { type: "dialog.changed", surfaceId: binding.surfaceId, dialog },
      }),
    });
    await expect(input).rejects.toMatchObject({ code: "dialog-open", dialog });
    socket.respond = true;
    await harness.respondDialog({ accept: false });
    expect(socket.requests.at(-1)).toMatchObject({
      action: { type: "dialog.respond", dialogId: dialog.id },
    });
    expect(socket.requests.filter((request) => request.action.type === "dom.act")).toHaveLength(1);
  });

  it("uses observed dialogs, preserves measured revisions and never retargets a closed tab", async () => {
    const { socket, harness } = fixture();
    await harness.ensureRealTab();
    const dialog = {
      id: "00000000-0000-4000-8000-000000000001",
      surfaceId: binding.surfaceId,
      type: "confirm",
      message: "Pay?",
    };
    socket.emit("message", {
      data: JSON.stringify({
        event: { type: "dialog.changed", surfaceId: binding.surfaceId, dialog },
      }),
    });
    await harness.respondDialog({ accept: false });
    expect(socket.requests.at(-1)).toMatchObject({
      action: { type: "dialog.respond", dialogId: dialog.id, accept: false },
    });
    socket.emit("message", {
      data: JSON.stringify({
        event: {
          type: "surface.changed",
          binding: { ...binding, documentId: "new-document", geometryRevision: 9 },
        },
      }),
    });
    await harness.page.mouse.click(10, 20);
    expect(socket.requests.at(-1)).toMatchObject({ documentId: "document-1", geometryRevision: 4 });
    socket.emit("message", {
      data: JSON.stringify({ event: { type: "surface.closed", surfaceId: binding.surfaceId } }),
    });
    await expect(harness.pageInfo()).rejects.toMatchObject({ code: "target-closed" });
  });

  it("stages bounded chunks, reuses opaque file handles and writes viewport captures", async () => {
    const { socket, harness } = fixture();
    const directory = await mkdtemp(path.join(tmpdir(), "phone-actions-"));
    try {
      const file = path.join(directory, "receipt.txt");
      await writeFile(file, Buffer.alloc(256 * 1_024 + 3));
      const handles = await harness.stageFiles([file]);
      expect(handles[0]).toMatch(/^staged:/u);
      const chunks = socket.requests.filter((request) => request.action.type === "file.stage");
      expect(
        chunks.map((request) =>
          request.action.type === "file.stage" ? request.action.offset : -1,
        ),
      ).toEqual([0, 256 * 1_024]);
      await harness.setInputFiles("input[type=file]", handles);
      await harness.setInputFiles({ x: 10, y: 20 }, handles);
      expect(
        socket.requests.filter((request) => request.action.type === "file.stage"),
      ).toHaveLength(2);
      const output = await harness.captureScreenshot(path.join(directory, "view.jpg"), {
        format: "jpeg",
        quality: 70,
      });
      expect(await readFile(output)).toEqual(Buffer.from("AAAA", "base64"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refuses arbitrary execution, emulation, clipboard, and unsupported keys before sending", async () => {
    const { socket, harness } = fixture();
    const calls = [
      () => harness.cdp("Runtime.evaluate"),
      () => harness.js("alert(1)"),
      () => harness.page.evaluate("alert(1)"),
      () => harness.page.locator("body").evaluate("alert(1)"),
      () => harness.page.waitForFunction("true"),
      () => harness.page.setViewportSize({ width: 1, height: 1 }),
      () => harness.page.keyboard.press("Meta+V"),
      () => harness.page.keyboard.press("Tab"),
      () => harness.page.getByText(/Pay/u),
      () => harness.page.getByRole("button", { includeHidden: true }),
      () => harness.page.getByRole("checkbox", { checked: true }),
      () => harness.page.locator("input").press("Tab"),
      () => harness.fillLogin("ref", "username"),
      () => harness.fillCard("ref", "number"),
      () => harness.page.screenshot({ fullPage: true }),
      () => harness.page.locator("select").selectOption({ label: "One" }),
      () => harness.page.locator("button").first().filter({ hasText: "Pay" }),
    ];
    for (const call of calls)
      await expect(Promise.resolve().then(call)).rejects.toMatchObject({
        code: "unsupported-operation",
      });
    expect(socket.requests).toEqual([]);
  });
});
