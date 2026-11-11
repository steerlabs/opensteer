import { BrowserSessionIdSchema, BrowserSurfaceIdSchema } from "@opensteer/core";
import { browserFrameFits, browserFrameLimits } from "@opensteer/browser-core/frame-limits";
import { utf8Size } from "@opensteer/browser-core/bytes";
import { z } from "zod";

export const browserActionMaxBytes = 432 * 1_024;
export const browserActionDefaultTimeoutMs = 10_000;
export const BrowserActionTimeoutSchema = z.number().int().min(1).max(30_000);
const identifier = z.string().min(1).max(255);
const text = z.string().max(10_000);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const boundedOutput = z.string().max(browserActionMaxBytes);
const coordinate = z.number().finite().min(0).max(32_768);
const point = z.strictObject({ x: coordinate, y: coordinate });
const viewport = z
  .strictObject({
    width: z.number().int().positive().max(browserFrameLimits.maxWidth),
    height: z.number().int().positive().max(browserFrameLimits.maxHeight),
  })
  .refine(({ width, height }) => browserFrameFits(width, height));
const url = z
  .string()
  .min(1)
  .max(16_384)
  .refine((value) => {
    try {
      const parsed = new URL(value);
      return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }, "Navigation requires HTTP(S) without credentials.");

export const BrowserActionErrorCodeSchema = z.enum([
  "unsupported-operation",
  "target-suspended",
  "target-closed",
  "stale-document",
  "stale-geometry",
  "ambiguous",
  "not-found",
  "not-actionable",
  "dialog-open",
  "stale-dialog",
  "timeout",
  "forbidden",
  "too-large",
  "outcome-unknown",
]);
export type BrowserActionErrorCode = z.infer<typeof BrowserActionErrorCodeSchema>;
export const BrowserActionDialogSchema = z.strictObject({
  id: z.uuid(),
  surfaceId: BrowserSurfaceIdSchema,
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string().max(10_000),
});
export const BrowserActionErrorSchema = z
  .strictObject({
    code: BrowserActionErrorCodeSchema,
    message: z.string().max(1_000),
    dialog: BrowserActionDialogSchema.optional(),
  })
  .refine((error) => error.code !== "dialog-open" || error.dialog !== undefined);

export interface BrowserActionLocator {
  readonly by: "css" | "role" | "text" | "label";
  readonly value: string;
  readonly name?: string | undefined;
  readonly exact?: boolean | undefined;
  readonly scope?: BrowserActionLocator | undefined;
  readonly position?: "first" | "last" | number | undefined;
  readonly hasText?: string | undefined;
  readonly hasNotText?: string | undefined;
  readonly visible?: boolean | undefined;
}
const locator: z.ZodType<BrowserActionLocator> = z.lazy(() =>
  z.strictObject({
    by: z.enum(["css", "role", "text", "label"]),
    value: z.string().min(1).max(4_096),
    name: z.string().max(4_096).optional(),
    exact: z.boolean().optional(),
    scope: locator.optional(),
    position: z.union([z.enum(["first", "last"]), z.number().int().min(0).max(10_000)]).optional(),
    hasText: z.string().max(4_096).optional(),
    hasNotText: z.string().max(4_096).optional(),
    visible: z.boolean().optional(),
  }),
);
export const BrowserActionLocatorSchema = z
  .unknown()
  .superRefine((value, context) => {
    let current = value;
    const seen = new Set<unknown>();
    for (let depth = 0; current && typeof current === "object"; depth++) {
      if (depth >= 8 || seen.has(current)) {
        context.addIssue({ code: "custom", message: "Locator scope exceeds eight levels." });
        return;
      }
      seen.add(current);
      current = (current as Record<string, unknown>).scope;
    }
  })
  .pipe(locator);

export const BrowserStageFileParametersSchema = z.strictObject({
  data: z
    .string()
    .max(Math.ceil((256 * 1_024) / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  name: z
    .string()
    .min(1)
    .refine(
      (value) =>
        utf8Size(value) <= 255 && value !== "." && value !== ".." && !/[/\\\0]/u.test(value),
      "File name must be one path segment.",
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(512 * 1_024 * 1_024),
  size: z
    .number()
    .int()
    .min(0)
    .max(512 * 1_024 * 1_024)
    .optional(),
});
const emptyAction = <Name extends string>(type: Name) => z.strictObject({ type: z.literal(type) });
const locatorFields = { locator: BrowserActionLocatorSchema };
export const BrowserActionSchema = z.discriminatedUnion("type", [
  emptyAction("session.tabs"),
  emptyAction("surface.attach"),
  emptyAction("surface.resume"),
  emptyAction("surface.close"),
  z.strictObject({
    type: z.literal("surface.open"),
    url: url.optional(),
    viewport: viewport.optional(),
  }),
  emptyAction("page.info"),
  z.strictObject({ type: z.literal("page.navigate"), url }),
  z.strictObject({
    type: z.literal("page.history"),
    direction: z.enum(["back", "forward", "reload", "stop"]),
  }),
  z.strictObject({
    type: z.literal("page.wait"),
    url: url.optional(),
    loadState: z.enum(["domcontentloaded", "load"]).optional(),
    timeout: BrowserActionTimeoutSchema,
  }),
  z.strictObject({
    type: z.literal("dom.snapshot"),
    scope: BrowserActionLocatorSchema.optional(),
    frameId: identifier.optional(),
  }),
  z
    .strictObject({
      type: z.literal("dom.query"),
      ...locatorFields,
      read: z.enum([
        "count",
        "textContent",
        "innerText",
        "allInnerTexts",
        "inputValue",
        "attribute",
        "visible",
        "checked",
        "enabled",
      ]),
      attribute: z.string().min(1).max(255).optional(),
    })
    .refine((action) => (action.read === "attribute") === (action.attribute !== undefined)),
  z
    .strictObject({
      type: z.literal("dom.act"),
      ...locatorFields,
      kind: z.enum([
        "click",
        "focus",
        "fill",
        "clear",
        "check",
        "uncheck",
        "setChecked",
        "selectOption",
      ]),
      button: z.literal("left").optional(),
      clickCount: z.union([z.literal(1), z.literal(2)]).optional(),
      selection: z.literal("end").optional(),
      value: z.union([text, z.boolean()]).optional(),
      values: z.array(text).max(100).optional(),
    })
    .refine((action) => {
      if (action.selection !== undefined && action.kind !== "focus") return false;
      if (action.kind === "fill")
        return (
          typeof action.value === "string" &&
          action.values === undefined &&
          action.button === undefined &&
          action.clickCount === undefined
        );
      if (action.kind === "setChecked")
        return (
          typeof action.value === "boolean" &&
          action.values === undefined &&
          action.button === undefined &&
          action.clickCount === undefined
        );
      if (action.kind === "selectOption")
        return (
          action.values !== undefined &&
          action.value === undefined &&
          action.button === undefined &&
          action.clickCount === undefined
        );
      return (
        action.value === undefined &&
        action.values === undefined &&
        (action.kind === "click" ||
          (action.button === undefined && action.clickCount === undefined))
      );
    }),
  z.strictObject({
    type: z.literal("dom.wait"),
    ...locatorFields,
    state: z.enum(["attached", "detached", "visible", "hidden"]),
    timeout: BrowserActionTimeoutSchema,
  }),
  z.strictObject({
    type: z.literal("pointer.tap"),
    ...point.shape,
    count: z.union([z.literal(1), z.literal(2)]),
  }),
  z.strictObject({
    type: z.literal("scroll"),
    x: coordinate.optional(),
    y: coordinate.optional(),
    deltaX: z.number().finite().min(-100_000).max(100_000),
    deltaY: z.number().finite().min(-100_000).max(100_000),
    locator: BrowserActionLocatorSchema.optional(),
  }),
  z.strictObject({ type: z.literal("text.insert"), text }),
  z.strictObject({ type: z.literal("text.key"), key: z.enum(["Enter", "Backspace"]) }),
  emptyAction("text.selectAll"),
  z.strictObject({
    type: z.literal("dialog.respond"),
    dialogId: z.uuid(),
    accept: z.boolean(),
    promptText: text.optional(),
  }),
  z.strictObject({
    type: z.literal("page.capture"),
    format: z.enum(["png", "jpeg"]),
    quality: z.number().int().min(0).max(100).optional(),
    clip: z
      .strictObject({ ...point.shape, width: coordinate.positive(), height: coordinate.positive() })
      .optional(),
  }),
  BrowserStageFileParametersSchema.extend({ type: z.literal("file.stage") }),
  z
    .strictObject({
      type: z.literal("file.choose"),
      locator: BrowserActionLocatorSchema.optional(),
      point: point.optional(),
      stagedFileIds: z
        .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u))
        .min(1)
        .max(256),
    })
    .refine((action) => (action.locator !== undefined) !== (action.point !== undefined)),
]);
export type BrowserAction = z.infer<typeof BrowserActionSchema>;

function withinBudget(value: unknown): boolean {
  try {
    return utf8Size(JSON.stringify(value)) <= browserActionMaxBytes;
  } catch {
    return false;
  }
}
export const BrowserActionRequestSchema = z
  .strictObject({
    id: revision,
    sessionId: BrowserSessionIdSchema,
    surfaceId: BrowserSurfaceIdSchema.optional(),
    documentId: identifier.optional(),
    geometryRevision: revision.optional(),
    timeoutMs: BrowserActionTimeoutSchema.default(browserActionDefaultTimeoutMs),
    action: BrowserActionSchema,
  })
  .superRefine((request, context) => {
    if (
      !["session.tabs", "surface.open"].includes(request.action.type) &&
      request.surfaceId === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["surfaceId"],
        message: "A surface operation requires its surface ID.",
      });
    if (
      !["session.tabs", "surface.open", "surface.attach", "surface.resume"].includes(
        request.action.type,
      ) &&
      !request.documentId
    )
      context.addIssue({
        code: "custom",
        path: ["documentId"],
        message: "A document operation requires its document ID.",
      });
    if (
      (request.action.type === "pointer.tap" ||
        request.action.type === "scroll" ||
        (request.action.type === "file.choose" && request.action.point !== undefined)) &&
      request.geometryRevision === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["geometryRevision"],
        message: "Coordinate input requires its geometry revision.",
      });
  })
  .refine(withinBudget, "The action exceeds the page byte budget.");
export type BrowserActionRequest = z.infer<typeof BrowserActionRequestSchema>;

export const BrowserActionBindingSchema = z.strictObject({
  surfaceId: BrowserSurfaceIdSchema,
  documentId: identifier,
  geometryRevision: revision,
  state: z.enum(["live", "suspended"]),
  title: z.string().max(1_000),
  url: z.string().max(16_384),
});
const bindingResult = <Name extends string>(type: Name) =>
  z.strictObject({ type: z.literal(type), binding: BrowserActionBindingSchema });
const voidResult = <Name extends string>(type: Name) => z.strictObject({ type: z.literal(type) });
export const BrowserActionResultSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("session.tabs"),
      tabs: z.array(BrowserActionBindingSchema),
    }),
    bindingResult("surface.attach"),
    bindingResult("surface.resume"),
    bindingResult("surface.open"),
    z.strictObject({
      type: z.literal("surface.close"),
      outcome: z.enum(["closed", "already-closed"]),
    }),
    z.strictObject({
      type: z.literal("page.info"),
      binding: BrowserActionBindingSchema,
      loading: z.boolean(),
      navigationFailed: z.boolean(),
      sizedByAgent: z.boolean(),
      dialog: BrowserActionDialogSchema.nullable(),
    }),
    bindingResult("page.navigate"),
    voidResult("page.history"),
    bindingResult("page.wait"),
    z.strictObject({ type: z.literal("dom.snapshot"), text: boundedOutput }),
    z.strictObject({
      type: z.literal("dom.query"),
      value: z.union([
        boundedOutput,
        z.number().finite(),
        z.boolean(),
        z.null(),
        z.array(text).max(10_000),
      ]),
    }),
    z.strictObject({
      type: z.literal("dom.act"),
      outcome: z.enum(["acted", "filled", "cleared", "checked", "unchecked", "selected"]),
      trusted: z.boolean(),
      values: z.array(text).max(100).optional(),
    }),
    voidResult("dom.wait"),
    voidResult("pointer.tap"),
    z.strictObject({
      type: z.literal("scroll"),
      x: z.number().finite(),
      y: z.number().finite(),
      source: z.enum(["native", "dom"]),
    }),
    voidResult("text.insert"),
    voidResult("text.key"),
    voidResult("text.selectAll"),
    voidResult("dialog.respond"),
    z.strictObject({
      type: z.literal("page.capture"),
      format: z.enum(["png", "jpeg"]),
      data: boundedOutput.regex(/^[A-Za-z0-9+/]+={0,2}$/u),
      viewport,
      width: coordinate.positive(),
      height: coordinate.positive(),
      clip: z
        .strictObject({
          ...point.shape,
          width: coordinate.positive(),
          height: coordinate.positive(),
        })
        .optional(),
    }),
    z.strictObject({ type: z.literal("file.stage"), fileId: identifier, complete: z.boolean() }),
    z.strictObject({
      type: z.literal("file.choose"),
      files: z.array(z.strictObject({ fileId: identifier, name: text, size: revision })).max(256),
    }),
  ])
  .refine(withinBudget, "The result exceeds the page byte budget.");
export type BrowserActionResult = z.infer<typeof BrowserActionResultSchema>;

export const BrowserActionResponseSchema = z.union([
  z.strictObject({ id: revision, result: BrowserActionResultSchema }),
  z.strictObject({ id: revision, error: BrowserActionErrorSchema }),
]);
export const BrowserActionEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("surface.changed"), binding: BrowserActionBindingSchema }),
  z.strictObject({ type: z.literal("surface.closed"), surfaceId: BrowserSurfaceIdSchema }),
  z.strictObject({
    type: z.literal("dialog.changed"),
    surfaceId: BrowserSurfaceIdSchema,
    dialog: BrowserActionDialogSchema.nullable(),
  }),
]);
export type BrowserActionEvent = z.infer<typeof BrowserActionEventSchema>;
export const BrowserAgentBackendSchema = z.strictObject({
  sessionId: BrowserSessionIdSchema,
  backend: z.enum(["cdp", "actions"]),
  version: z.literal(1),
});
export type BrowserAgentBackend = z.infer<typeof BrowserAgentBackendSchema>;

export const BrowserAgentAttachSchema = z.strictObject({
  type: z.literal("agent.attach"),
  sessionId: BrowserSessionIdSchema,
  attachmentId: z.uuid(),
  actorToken: z.uuid(),
  backend: z.enum(["cdp", "actions"]),
});
export const BrowserAgentDetachSchema = z.strictObject({
  type: z.literal("agent.detach"),
  sessionId: BrowserSessionIdSchema,
  attachmentId: z.uuid(),
});
export const BrowserAgentActionSchema = z.strictObject({
  type: z.literal("agent.action"),
  attachmentId: z.uuid(),
  actorToken: z.uuid(),
  requestId: z.uuid(),
  request: BrowserActionRequestSchema,
});
export const BrowserAgentResultSchema = z.strictObject({
  type: z.literal("agent.result"),
  attachmentId: z.uuid(),
  requestId: z.uuid(),
  result: BrowserActionResultSchema,
});
export const BrowserAgentErrorSchema = z.strictObject({
  type: z.literal("agent.error"),
  attachmentId: z.uuid(),
  requestId: z.uuid(),
  error: BrowserActionErrorSchema,
});
export const BrowserAgentEventSchema = z.strictObject({
  type: z.literal("agent.event"),
  attachmentId: z.uuid(),
  event: BrowserActionEventSchema,
});

export const BrowserResumeTabParametersSchema = z.strictObject({
  surfaceId: BrowserSurfaceIdSchema,
});
export const BrowserResumeTabResultSchema = z.strictObject({
  surfaceId: BrowserSurfaceIdSchema,
  targetId: identifier,
  documentId: z.string().min(1).max(255),
  reloaded: z.boolean(),
});
export type BrowserResumeTabResult = z.infer<typeof BrowserResumeTabResultSchema>;
export const BrowserListTabsParametersSchema = z.strictObject({
  cursor: z.string().regex(/^\d+$/u).optional(),
});
export const AgentTabSchema = z.strictObject({
  surfaceId: BrowserSurfaceIdSchema,
  targetId: identifier.nullable(),
  state: z.enum(["live", "suspended"]),
  title: z.string().max(256),
  url: z.string().max(16_384),
  order: z.number().int().nonnegative(),
  openerId: BrowserSurfaceIdSchema.nullable(),
  userActivity: z
    .strictObject({
      at: z.string(),
      kind: z.enum(["click", "scroll", "typing", "navigation", "dialog"]),
      x: z.number().optional(),
      y: z.number().optional(),
      sinceLastAgentCommand: z.boolean(),
    })
    .nullable(),
  pageResize: z
    .strictObject({
      at: z.string(),
      width: z.number(),
      height: z.number(),
      agentSizeRemoved: z.literal(true).optional(),
      sinceLastAgentCommand: z.boolean(),
    })
    .nullable(),
  dialog: z
    .strictObject({ id: z.string(), message: z.string().max(10_000), type: z.string() })
    .nullable(),
});
export type AgentTab = z.infer<typeof AgentTabSchema>;
/** Page target; one larger record travels alone within browserActionMaxBytes. */
export const browserListTabsMaxBytes = 64 * 1024;
export const BrowserListTabsResultSchema = z.strictObject({
  tabs: z.array(AgentTabSchema),
  nextCursor: z.string().nullable(),
});

export type BrowserListTabsResult = z.infer<typeof BrowserListTabsResultSchema>;
