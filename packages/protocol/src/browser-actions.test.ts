import { createId } from "@opensteer/core";
import { describe, expect, it } from "vitest";
import {
  BrowserActionRequestSchema,
  BrowserActionResultSchema,
  BrowserActionErrorCodeSchema,
  BrowserActionLocatorSchema,
  BrowserAgentBackendSchema,
  type BrowserAction,
  pageBrowserTabs,
  browserListTabsMaxBytes,
} from "./browser-actions.js";
import {
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  BrowserAttachTicketClaimsSchema,
  browserBasicInputAllows,
  createBrowserSessionId,
} from "./browser.js";
import { RunnerBrowserModuleSchema } from "./runner.js";
import {
  HostToBrowserRelayMessageSchema,
  BrowserRelayToHostMessageSchema,
} from "./browser-relay.js";

const uuid = "11111111-1111-4111-8111-111111111111";
const sessionId = createBrowserSessionId();
const surfaceId = "page-phone";
const locator = { by: "role" as const, value: "button", name: "Continue" };
const binding = {
  surfaceId,
  documentId: "doc",
  geometryRevision: 1,
  state: "live",
  title: "Phone",
  url: "https://example.test/",
};
const request = { id: 1, sessionId, surfaceId, documentId: "doc", geometryRevision: 1 };
const examples: readonly { action: BrowserAction; result: unknown }[] = [
  { action: { type: "session.tabs" }, result: { tabs: [binding], nextCursor: null } },
  ...["surface.attach", "surface.resume", "surface.open", "page.navigate", "page.wait"].map(
    (type) => ({
      action: {
        type,
        ...(type === "page.navigate" ? { url: "https://example.test/" } : {}),
        ...(type === "page.wait" ? { timeout: 100 } : {}),
      } as BrowserAction,
      result: { binding },
    }),
  ),
  { action: { type: "surface.close" }, result: { outcome: "closed" } },
  {
    action: { type: "page.info" },
    result: { binding, loading: false, navigationFailed: false, sizedByAgent: false, dialog: null },
  },
  { action: { type: "page.history", direction: "back" }, result: {} },
  { action: { type: "dom.snapshot" }, result: { text: "button Continue" } },
  { action: { type: "dom.query", locator, read: "count" }, result: { value: 1 } },
  {
    action: { type: "dom.act", locator, kind: "fill", value: "Hello" },
    result: { outcome: "filled", trusted: true },
  },
  { action: { type: "dom.wait", locator, state: "visible", timeout: 500 }, result: {} },
  { action: { type: "pointer.tap", x: 1, y: 2, count: 2 }, result: {} },
  {
    action: { type: "scroll", deltaX: 0, deltaY: 100 },
    result: { x: 0, y: 100, source: "native" },
  },
  { action: { type: "text.insert", text: "Hello" }, result: {} },
  { action: { type: "text.key", key: "Backspace" }, result: {} },
  { action: { type: "text.selectAll" }, result: {} },
  { action: { type: "dialog.respond", dialogId: uuid, accept: false }, result: {} },
  {
    action: { type: "page.capture", format: "png" },
    result: {
      format: "png",
      data: "AQ==",
      viewport: { width: 390, height: 844 },
      width: 390,
      height: 844,
    },
  },
  {
    action: {
      type: "file.stage",
      fileId: "upload",
      name: "test.txt",
      offset: 0,
      data: "aGk=",
      size: 2,
    },
    result: { fileId: "upload", complete: true },
  },
  {
    action: { type: "file.choose", locator, stagedFileIds: ["upload"] },
    result: { files: [{ fileId: "upload", name: "test.txt", size: 2 }] },
  },
];
const fence = {
  bootId: `rbt_${uuid}`,
  connectionGeneration: 1,
  connectionId: `rcn_${uuid}`,
  connectionLeaseId: `rls_${uuid}`,
  runnerId: createId("runner"),
  auxiliaryStreamId: `rax_${uuid}`,
  module: "browser",
};
const relay = {
  ...fence,
  channelId: `bch_${uuid}`,
  capability: { runtimeId: "phone", capabilityGeneration: 1, capabilityLeaseId: `bcl_${uuid}` },
};

describe("typed browser agent wire", () => {
  it("includes the final null cursor in a tab page's byte budget", () => {
    const empty = { tabs: ["x", ""], nextCursor: "1" };
    const record =
      "界".repeat(100) +
      "x".repeat(browserListTabsMaxBytes - Buffer.byteLength(JSON.stringify(empty)) - 300);
    const result = pageBrowserTabs(
      [
        { order: 0, tab: "x" },
        { order: 1, tab: record },
      ],
      undefined,
      (page) => page,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(browserListTabsMaxBytes);
    expect(result.nextCursor).toBe("0");
    expect(
      pageBrowserTabs([{ order: 1, tab: record }], result.nextCursor!, (page) => page),
    ).toEqual({ tabs: [record], nextCursor: null });
  });

  it("carries a tab-list cursor and requires the next page identity", () => {
    expect(
      BrowserActionRequestSchema.parse({
        id: 1,
        sessionId,
        action: { type: "session.tabs", cursor: "42" },
      }).action,
    ).toEqual({ type: "session.tabs", cursor: "42" });
    expect(
      BrowserActionResultSchema.parse({
        type: "session.tabs",
        tabs: [binding],
        nextCursor: "43",
      }),
    ).toMatchObject({ nextCursor: "43" });
    for (const cursor of ["-1", "1.5", "9007199254740992", "x"])
      expect(
        BrowserActionRequestSchema.safeParse({
          id: 1,
          sessionId,
          action: { type: "session.tabs", cursor },
        }).success,
      ).toBe(false);
  });

  it("admits payload-free focus and surface-free session actions, keeping existing target fences", () => {
    const focus = { type: "dom.act", kind: "focus", locator };
    expect(BrowserActionRequestSchema.safeParse({ ...request, action: focus }).success).toBe(true);
    expect(
      BrowserActionRequestSchema.safeParse({ ...request, action: { ...focus, selection: "end" } })
        .success,
    ).toBe(true);
    expect(
      BrowserActionRequestSchema.safeParse({
        ...request,
        action: { ...focus, kind: "click", selection: "end" },
      }).success,
    ).toBe(false);
    expect(
      BrowserActionRequestSchema.safeParse({ ...request, action: { ...focus, selection: "all" } })
        .success,
    ).toBe(false);
    for (const extra of [{ value: "text" }, { values: [] }, { button: "left" }, { clickCount: 1 }])
      expect(
        BrowserActionRequestSchema.safeParse({ ...request, action: { ...focus, ...extra } })
          .success,
      ).toBe(false);
    for (const action of [
      { type: "session.tabs" },
      { type: "surface.open", url: "https://example.test/" },
    ])
      expect(BrowserActionRequestSchema.parse({ id: 1, sessionId, action })).not.toHaveProperty(
        "surfaceId",
      );
    for (const { action } of examples.filter(
      ({ action }) => !["session.tabs", "surface.open"].includes(action.type),
    ))
      expect(
        BrowserActionRequestSchema.safeParse({ ...request, surfaceId: undefined, action }).success,
        action.type,
      ).toBe(false);
    expect(
      BrowserActionRequestSchema.safeParse({ ...request, action: focus, documentId: undefined })
        .success,
    ).toBe(false);
    expect(
      BrowserActionRequestSchema.safeParse({
        ...request,
        action: { type: "surface.close" },
        documentId: undefined,
      }).success,
    ).toBe(false);
  });
  it.each(examples)(
    "admits $action.type through the fenced relay with its bounded result",
    ({ action, result }) => {
      const parsed = BrowserActionRequestSchema.parse({ ...request, action });
      expect(parsed.timeoutMs).toBe(10_000);
      const message = {
        type: "agent.action",
        attachmentId: uuid,
        actorToken: uuid,
        requestId: uuid,
        request: parsed,
      };
      expect(BrowserClientMessageSchema.parse(message)).toEqual(message);
      expect(
        HostToBrowserRelayMessageSchema.parse({
          ...relay,
          type: "browser.client-message",
          message,
        }),
      ).toMatchObject({ message });
      const answered = {
        type: "agent.result",
        attachmentId: uuid,
        requestId: uuid,
        result: { type: action.type, ...(result as object) },
      };
      expect(BrowserServerMessageSchema.parse(answered)).toEqual(answered);
      expect(
        BrowserRelayToHostMessageSchema.parse({
          ...relay,
          type: "browser.server-message",
          message: answered,
        }),
      ).toMatchObject({ message: answered });
      expect(
        BrowserActionRequestSchema.safeParse({ ...request, action: { ...action, unchecked: true } })
          .success,
      ).toBe(false);
      expect(
        BrowserActionResultSchema.safeParse({
          type: action.type,
          ...(result as object),
          unchecked: true,
        }).success,
      ).toBe(false);
    },
  );

  it("keeps attachment and actor authority outside caller input", () => {
    for (const field of ["attachmentId", "actorToken", "producerId"])
      expect(
        BrowserActionRequestSchema.safeParse({
          ...request,
          action: { type: "page.info" },
          [field]: uuid,
        }).success,
      ).toBe(false);
    for (const message of [
      { type: "agent.attach", attachmentId: uuid, actorToken: uuid, backend: "actions", sessionId },
      { type: "agent.detach", attachmentId: uuid, sessionId },
    ])
      expect(BrowserClientMessageSchema.parse(message)).toEqual(message);
    for (const code of BrowserActionErrorCodeSchema.options) {
      const error = {
        code,
        message: code,
        ...(code === "dialog-open"
          ? { dialog: { id: uuid, surfaceId, type: "alert", message: "Hello" } }
          : {}),
      };
      const message = { type: "agent.error", attachmentId: uuid, requestId: uuid, error };
      expect(BrowserServerMessageSchema.parse(message)).toEqual(message);
    }
    for (const event of [
      { type: "surface.changed", binding },
      { type: "surface.closed", surfaceId },
      { type: "dialog.changed", surfaceId, dialog: null },
    ])
      expect(
        BrowserServerMessageSchema.parse({ type: "agent.event", attachmentId: uuid, event }),
      ).toMatchObject({ event });
    expect(
      BrowserAgentBackendSchema.parse({ sessionId, backend: "actions", version: 1 }),
    ).toMatchObject({ backend: "actions" });
  });

  it("refuses scripts, clipboard, missing provenance, oversized data and unbounded waits/locators", () => {
    for (const action of [
      { type: "evaluate", script: "alert(1)" },
      { type: "clipboard.paste", text: "secret" },
      { type: "text.key", key: "Tab" },
      { type: "page.wait", timeout: 30_001 },
      { type: "dom.act", locator, kind: "fill" },
      { type: "page.navigate", url: "https://user:secret@example.test" },
      { type: "page.navigate", url: "file:///private/file" },
      { type: "file.choose", locator, point: { x: 0, y: 0 }, stagedFileIds: ["file"] },
    ])
      expect(BrowserActionRequestSchema.safeParse({ ...request, action }).success).toBe(false);
    expect(
      BrowserActionRequestSchema.safeParse({
        ...request,
        documentId: undefined,
        action: { type: "page.info" },
      }).success,
    ).toBe(false);
    expect(
      BrowserActionRequestSchema.safeParse({
        ...request,
        geometryRevision: undefined,
        action: { type: "pointer.tap", x: 1, y: 1, count: 1 },
      }).success,
    ).toBe(false);
    for (const type of ["session.tabs", "surface.attach", "surface.resume"])
      expect(
        BrowserActionRequestSchema.safeParse({
          ...request,
          documentId: undefined,
          action: { type },
        }).success,
      ).toBe(true);
    expect(
      BrowserActionResultSchema.safeParse({ type: "dom.snapshot", text: "界".repeat(200_000) })
        .success,
    ).toBe(false);
    let deep: unknown = locator;
    for (let depth = 0; depth < 9; depth++) deep = { ...locator, scope: deep };
    expect(BrowserActionLocatorSchema.safeParse(deep).success).toBe(false);
    expect(
      BrowserActionLocatorSchema.safeParse({ ...locator, script: "readClipboard()" }).success,
    ).toBe(false);
  });

  it("negotiates narrow input and surface state without granting full editing or altering older peers", () => {
    const descriptor = {
      runtimeId: "phone",
      wireVersion: 2,
      basicInput: 1,
      surfaceState: 1,
      agentActions: 1,
    };
    expect(RunnerBrowserModuleSchema.parse(descriptor)).toEqual(descriptor);
    expect(RunnerBrowserModuleSchema.parse({ runtimeId: "old" })).not.toHaveProperty("basicInput");
    expect(
      RunnerBrowserModuleSchema.parse({ ...descriptor, basicInput: 2 }).basicInput,
    ).toBeUndefined();
    const claims = {
      access: "read-write",
      audience: "opensteer-browser-runtime",
      wireVersion: 2,
      operationExpiresAt: "2026-11-09T12:00:18Z",
      remainingBudgetMs: 18_000,
      expiresAt: "2026-11-09T12:01:00Z",
      identity: { kind: "fresh" },
      issuedAt: "2026-11-09T12:00:00Z",
      nonce: "a".repeat(32),
      runtimeId: "phone",
      sessionId,
      subject: "owner",
    };
    expect(
      BrowserAttachTicketClaimsSchema.parse({ ...claims, basicInput: 1, surfaceState: 1 }),
    ).not.toHaveProperty("editingVersion");
    expect(BrowserAttachTicketClaimsSchema.parse(claims)).not.toHaveProperty("surfaceState");
    const snapshot = {
      type: "browser.snapshot",
      access: "read-write",
      dialog: null,
      sessionId,
      state: "ready",
      basicInput: 1,
      surfaceState: 1,
      surfaces: [
        { id: surfaceId, active: true, title: "Phone", url: "about:blank", state: "suspended" },
      ],
    };
    expect(BrowserServerMessageSchema.parse(snapshot)).toEqual(snapshot);
    expect(BrowserServerMessageSchema.safeParse({ ...snapshot, basicInput: 2 }).success).toBe(
      false,
    );
    expect(
      BrowserServerMessageSchema.safeParse({
        ...snapshot,
        surfaces: [{ ...snapshot.surfaces[0], state: "retained" }],
      }).success,
    ).toBe(false);
  });

  it("admits only the fixed basic input subset", () => {
    const allowed = [
      { type: "input.command", command: "selectAll" },
      { type: "input.command", command: "deleteBackward" },
      { type: "input.key", action: "down", key: "Enter", code: "Enter", modifiers: [] },
      { type: "input.text", edit: { contextId: uuid, text: "Hello", before: "", after: "" } },
      {
        type: "input.compose",
        composition: { contextId: uuid, text: "字", selectionStart: 1, selectionEnd: 1 },
      },
      { type: "clipboard.copy", operationId: uuid },
      { type: "clipboard.paste", text: "Hello" },
      { type: "clipboard.paste-data", operationId: uuid, items: [{ type: "text/plain", size: 2 }] },
    ];
    const denied = [
      { type: "input.key", action: "down", key: "Enter", code: "KeyV", modifiers: [] },
      {
        type: "input.key",
        action: "down",
        key: "Enter",
        code: "Enter",
        text: "paste",
        modifiers: [],
      },
      { type: "input.command", command: "undo" },
      { type: "input.command", command: "deleteForward" },
      { type: "input.key", action: "down", key: "Tab", code: "Tab", modifiers: [] },
      { type: "input.key", action: "down", key: "v", code: "KeyV", modifiers: ["primary"] },
      { type: "input.text", edit: { contextId: uuid, text: "Hi", before: "Hello", after: "" } },
      {
        type: "input.compose",
        composition: {
          contextId: uuid,
          text: "字",
          selectionStart: 1,
          selectionEnd: 1,
          before: "x",
        },
      },
      { type: "clipboard.cut", operationId: uuid },
      { type: "clipboard.paste-data", operationId: uuid, items: [{ type: "text/html", size: 2 }] },
    ];
    for (const message of allowed)
      expect(
        browserBasicInputAllows(BrowserClientMessageSchema.parse({ surfaceId, ...message })),
        JSON.stringify(message),
      ).toBe(true);
    for (const message of denied)
      expect(
        browserBasicInputAllows(BrowserClientMessageSchema.parse({ surfaceId, ...message })),
        JSON.stringify(message),
      ).toBe(false);
  });
});
