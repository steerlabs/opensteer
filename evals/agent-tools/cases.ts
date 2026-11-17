import { z } from "zod";
import {
  createId,
  IsoDateTimeSchema,
  ThreadAccessModeSchema,
  MessageOriginSchema,
  type MessageOrigin,
  TeamTurnContextSchema,
} from "@opensteer/core";
import { HarnessInputSchema } from "@opensteer/protocol";
import { memoryPassWakeText } from "@opensteer/triggers";
import {
  ThreadDetailSchema,
  ThreadItemSchema,
} from "../../packages/agent-tools/src/tools/outputs.js";

const regex = z.string().superRefine((value, ctx) => {
  try {
    new RegExp(value, "u");
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid regular expression" });
  }
});
const fixturePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value
        .split("/")
        .every(
          (part) => part !== ".." && part !== "." && part !== "" && !part.startsWith(".eval-"),
        ),
    "Fixture must be a relative path without traversal",
  );
const call = z.strictObject({
  tool: z.string().min(1),
  args: z.record(z.string(), z.json()).default({}),
});
const structuredTurn = z
  .strictObject({
    text: z.string().min(1).optional(),
    content: HarnessInputSchema.shape.content.optional(),
    author: HarnessInputSchema.shape.author,
    kind: HarnessInputSchema.shape.kind,
  })
  .superRefine((turn, ctx) => {
    if ((turn.text === undefined) === (turn.content === undefined))
      ctx.addIssue({ code: "custom", message: "Provide exactly one of text or content" });
    const result = HarnessInputSchema.safeParse({
      author: turn.author,
      kind: turn.kind,
      content: turn.content ?? [{ type: "text", text: turn.text }],
      createdAt: new Date().toISOString(),
      messageId: createId("message"),
    });
    if (!result.success)
      for (const issue of result.error.issues)
        ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  });
const fileRules = z
  .array(
    z.strictObject({
      path: z.union([fixturePath, z.literal("."), z.array(fixturePath).min(1)]),
      exists: z.boolean().optional(),
      recursive: z.boolean().default(false),
      matchingText: regex.optional(),
      count: z.number().int().nonnegative().optional(),
      mode: z.number().int().min(0).max(0o777).optional(),
      gitIgnored: z.boolean().optional(),
      exclude: z.array(fixturePath).default([]),
      textMust: z.array(regex).default([]),
      textMustNot: z.array(regex).default([]),
    }),
  )
  .default([]);
const fixtureTab = z
  .strictObject({
    tabId: z.string().min(1),
    kind: z.enum(["page", "window", "phone", "app"]).default("page"),
    title: z.string(),
    url: z.string().optional(),
    /** A page's identity: a profile, or null for Guest. */
    profile: z.strictObject({ profileId: z.string(), name: z.string() }).nullable().optional(),
    /** The computer's name; its ID comes from `computers` or is derived from the name. */
    computer: z.string().min(1),
    state: z.enum(["open", "asleep", "unavailable"]),
    unavailableReason: z.string().min(1).optional(),
    groupId: z.string().nullable().default(null),
    openedBy: z.enum(["person", "this-task", "other-task"]).default("person"),
    usedBy: z.array(z.enum(["this-task", "other-task"])).default([]),
    appId: z.string().optional(),
    appName: z.string().optional(),
    bundleId: z.string().optional(),
    windowId: z.string().optional(),
    /** iPhone pages take typed actions and refuse CDP and page scripts. */
    backend: z.enum(["cdp", "actions"]).default("cdp"),
    pageText: z.string().optional(),
    pageTitle: z.string().optional(),
    cookies: z.array(z.looseObject({})).optional(),
    /** Harness helpers whose next use sends input and then reports an unknown outcome. */
    outcomeUnknown: z.array(z.string()).default([]),
  })
  .superRefine((tab, ctx) => {
    if (tab.kind === "page" && (tab.url === undefined || tab.profile === undefined))
      ctx.addIssue({ code: "custom", message: "A page tab needs url and profile (null is Guest)" });
    if (tab.kind === "window" && (!tab.appName || !tab.bundleId || !tab.windowId))
      ctx.addIssue({
        code: "custom",
        message: "A window tab needs appName, bundleId and windowId",
      });
    if (tab.kind === "app" && !tab.appId)
      ctx.addIssue({ code: "custom", message: "An app tab needs appId" });
    if ((tab.state === "unavailable") !== (tab.unavailableReason !== undefined))
      ctx.addIssue({ code: "custom", message: "Only an unavailable tab has unavailableReason" });
  });
export const BrowserFixtureSchema = z.strictObject({
  profiles: z
    .array(
      z.looseObject({
        id: z.string(),
        name: z.string(),
        computer: z.string().nullable().optional(),
      }),
    )
    .default([]),
  tabs: z.array(fixtureTab).default([]),
  groups: z
    .array(
      z.strictObject({
        groupId: z.string().regex(/^tgp_[0-9a-f-]{36}$/u),
        name: z.string().min(1),
        color: z.string().default("grey"),
        collapsed: z.boolean().default(false),
      }),
    )
    .default([]),
  computers: z
    .array(z.strictObject({ computerId: z.string().regex(/^(?:rnr|dev)_/u), name: z.string() }))
    .default([]),
  /** Where Guest pages open when no computer is named. */
  hostingComputer: z.string().default("This Mac"),
  offlineComputers: z.array(z.string()).default([]),
  accessRequiredComputers: z.array(z.string()).default([]),
  personActiveTab: z.string().optional(),
  /** Windows computer_use could discover; tab_open binds them by windowId or bundleId. */
  windows: z
    .array(
      z.strictObject({
        windowId: z.string().regex(/^win_[0-9a-f-]{36}$/u),
        computer: z.string(),
        appName: z.string(),
        bundleId: z.string(),
        title: z.string(),
      }),
    )
    .default([]),
  phones: z.array(z.strictObject({ computer: z.string(), name: z.string() })).default([]),
  apps: z
    .array(
      z.strictObject({ appId: z.string().regex(/^app_/u), name: z.string(), computer: z.string() }),
    )
    .default([]),
});
export type BrowserFixture = z.infer<typeof BrowserFixtureSchema>;
const harnessCall = z.strictObject({
  call: z.string().min(1),
  args: z.record(z.string(), z.json()).default({}),
});
export const CaseSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    after: z.string().optional(),
    area: z.string().min(1),
    kind: z.enum(["bad", "guard", "control"]),
    source: z.strictObject({
      commit: z.string().regex(/^[a-f0-9]{40}$/u),
      note: z.string().min(1),
    }),
    profile: z.enum(["task", "delegated"]),
    caller: z.enum(["run", "connection"]).default("run"),
    /** The Run's access mode; a limited Codex Run cannot run Browser Harness. */
    accessMode: ThreadAccessModeSchema.default("full-access"),
    /** Capabilities the Host plan withholds from this Run; omitted ones are present. */
    capabilities: z
      .strictObject({
        tabs: z.boolean(),
        pages: z.boolean(),
        computerUse: z.boolean(),
        apps: z.boolean(),
      })
      .partial()
      .default({}),
    /**
     * Real local HTTP servers standing in for published server apps, by name: each maps
     * "METHOD /path" to its JSON response. Mocks may say {{appServer:<name>}} for its localUrl.
     */
    appServers: z
      .record(z.string().regex(/^[a-z0-9-]+$/u), z.record(z.string(), z.json()))
      .default({}),
    purpose: z.enum(["task", "voice", "background-job"]).default("task"),
    assigned: z.boolean().optional(),
    voice: z.boolean().optional(),
    teamBound: z.boolean().default(false),
    /** The owner is linked to a team, so the Run gets team knowledge. */
    knowledge: z.boolean().default(false),
    teamContext: TeamTurnContextSchema.optional(),
    machineAccessNotice: z.string().min(1).optional(),
    /** The operating system of the computer hosting the Run, as its Runner reports it. */
    hostingPlatform: z.enum(["darwin", "linux", "win32"]).default("darwin"),
    /** Rebase this fixture's ISO instants onto the actual Run clock. */
    timeAnchor: IsoDateTimeSchema.optional(),
    /** Where the person's turns come from, as their app states it. */
    origin: MessageOriginSchema.optional(),
    engines: z
      .array(z.enum(["claude", "codex", "cursor", "opencode", "pi"]))
      .min(1)
      .optional(),
    browser: BrowserFixtureSchema.optional(),
    fixtures: z.record(fixturePath, z.string()).default({}),
    /** Published task messages, including this worker's prior handoffs. Explicit mocks win. */
    tasks: z
      .array(
        z.strictObject({
          task: ThreadDetailSchema,
          items: z.array(ThreadItemSchema),
          self: z.boolean().default(false),
        }),
      )
      .default([]),
    gitRepository: z.boolean().default(false),
    turns: z.array(z.union([z.string().min(1), structuredTurn])).min(1),
    mocks: z.record(z.string(), z.json()).default({}),
    expect: z.strictObject({
      harness: z.array(harnessCall).default([]),
      notHarness: z.array(z.union([z.string(), harnessCall])).default([]),
      files: fileRules,
      /** Snapshot before matching calls, until ordered groups of successful results complete. */
      boundaries: z
        .array(
          z.strictObject({
            call: call.optional(),
            until: z
              .array(z.array(call.extend({ result: z.json().optional() })).min(1))
              .default([]),
            files: fileRules,
          }),
        )
        .default([]),
      callsOnlyKeys: z.array(call.extend({ keys: z.array(z.string()) })).default([]),
      calls: z.array(call.extend({ withoutKeys: z.array(z.string()).optional() })).default([]),
      notCalls: z.array(z.string()).default([]),
      notCallsWithArgs: z.array(call).default([]),
      callsArgMatch: z
        .array(
          z.strictObject({
            tool: z.string().min(1),
            args: z.record(z.string(), z.json()).default({}),
            path: z.array(z.string().min(1)).min(1),
            pattern: regex,
            first: z.boolean().default(false),
            /** Only calls after the first valid one matching this, result included, count. */
            after: call.extend({ result: z.json() }).optional(),
          }),
        )
        .default([]),
      notCallsArgMatch: z
        .array(
          z.strictObject({
            tool: z.string().min(1),
            args: z.record(z.string(), z.json()).default({}),
            path: z.array(z.string().min(1)).min(1),
            pattern: regex,
            /** Only calls after the first valid one matching this count; absent checks every call. */
            after: call.extend({ result: z.json() }).optional(),
          }),
        )
        .default([]),
      finalText: z.enum(["empty", "nonempty"]).optional(),
      maxFinalTextBytes: z.number().int().nonnegative().optional(),
      order: z.array(z.string()).default([]),
      minCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
      maxCalls: z.record(z.string(), z.number().int().nonnegative()).default({}),
      noAssistantText: z.boolean().default(false),
      textMust: z.array(regex).default([]),
      textMustNot: z.array(regex).default([]),
      /** Checked against assistant text from turns before the graded last turn. */
      earlierTextMust: z.array(regex).default([]),
      maxInvalidCalls: z.number().int().nonnegative().default(0),
    }),
  })
  .superRefine((c, ctx) => {
    if (c.tasks.filter((task) => task.self).length > 1)
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "Only one task can be self" });
    if (new Set(c.tasks.map(({ task }) => task.id)).size !== c.tasks.length)
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "Task IDs must be unique" });
    for (const [, app] of JSON.stringify(c.mocks).matchAll(/\{\{appServer:([a-z0-9-]+)\}\}/gu))
      if (!Object.hasOwn(c.appServers, app!))
        ctx.addIssue({
          code: "custom",
          path: ["mocks"],
          message: `No appServers entry named ${app}`,
        });
  });
export type EvalCase = z.infer<typeof CaseSchema>;
export function caseAtTime(testCase: EvalCase, now: number): EvalCase {
  if (!testCase.timeAnchor) return testCase;
  const delta = now - Date.parse(testCase.timeAnchor);
  return CaseSchema.parse(
    JSON.parse(
      JSON.stringify(testCase).replace(
        /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/gu,
        (instant) => new Date(Date.parse(instant) + delta).toISOString(),
      ),
    ),
  );
}

const memoryWake = /^(Light|Nightly) pass due \(([^)]+)\)/u;
const firstPassWindow = { Light: 24 * 60 * 60 * 1000, Nightly: 28 * 24 * 60 * 60 * 1000 };

/**
 * Appends the Host's list to each memory wake, rendered from the case's tasks as the Host
 * would: since the self task's last completed handoff less the commit overlap, or the first
 * pass's window, skipping managed workers.
 */
export function withHostMemoryWakes(testCase: EvalCase): EvalCase {
  const published = (items: EvalCase["tasks"][number]["items"]) =>
    items.filter((item) => item.type === "message" && item.status === "published");
  const handoff = published(testCase.tasks.find(({ self }) => self)?.items ?? [])
    .filter((item) => item.runId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .at(-1);
  const turns = testCase.turns.map((turn) => {
    if (typeof turn === "string" || turn.author.kind !== "trigger" || !turn.text) return turn;
    const [, label, at] = turn.text.match(memoryWake) ?? [];
    if (!label || !at || turn.text.includes("\n\n")) return turn;
    const since = new Date(
      handoff
        ? Date.parse(handoff.createdAt) - 10 * 60 * 1000
        : Date.parse(at) - firstPassWindow[label as keyof typeof firstPassWindow],
    );
    const changes = testCase.tasks.flatMap(({ task, items, self }) => {
      if (self || task.purpose === "background-job") return [];
      const fresh = published(items).filter((item) => Date.parse(item.createdAt) > since.getTime());
      if (!fresh.length) return [];
      const dates = fresh.map((item) => Date.parse(item.createdAt));
      return [
        {
          id: task.id,
          title: task.title ?? "",
          count: fresh.length,
          first: new Date(Math.min(...dates)),
          newest: Math.max(...dates),
          sources: [
            ...new Map(
              fresh.flatMap((item) =>
                item.teamSource
                  ? [[JSON.stringify(item.teamSource), item.teamSource] as const]
                  : [],
              ),
            ).values(),
          ],
        },
      ];
    });
    changes.sort((a, b) => b.newest - a.newest);
    const list = memoryPassWakeText({
      since,
      completedRunId: handoff?.runId ?? null,
      changes,
      more: false,
    });
    return { ...turn, text: `${turn.text}\n\n${list}` };
  });
  return { ...testCase, turns };
}

export function parseCases(text: string): EvalCase[] {
  const ids = new Set<string>();
  const cases = text.split(/\r?\n/u).flatMap((line, i) => {
    if (!line.trim()) return [];
    try {
      const value = withHostMemoryWakes(CaseSchema.parse(JSON.parse(line)));
      if (ids.has(value.id)) throw new Error(`Duplicate case ${value.id}`);
      ids.add(value.id);
      return [value];
    } catch (cause) {
      throw new Error(`Case line ${i + 1}: ${String(cause)}`, { cause });
    }
  });
  for (const c of cases) {
    if (c.after && !cases.slice(0, cases.indexOf(c)).some((p) => p.id === c.after))
      throw new Error(`Case ${c.id}: after must name an earlier case`);
  }
  return cases;
}

export function inputForCaseTurn(turn: EvalCase["turns"][number], origin?: MessageOrigin) {
  const human = typeof turn === "string" || turn.author.kind === "human";
  return HarnessInputSchema.parse({
    ...(origin && human ? { origin } : {}),
    author:
      typeof turn === "string"
        ? { kind: "human", displayName: "Eval user", principalId: "eval" }
        : turn.author,
    content:
      typeof turn === "string"
        ? [{ type: "text", text: turn }]
        : (turn.content ?? [{ type: "text", text: turn.text }]),
    kind: typeof turn === "string" ? "input" : turn.kind,
    createdAt: new Date().toISOString(),
    messageId: createId("message"),
  });
}
