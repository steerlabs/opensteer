import { describe, expect, it } from "vitest";
import { ModelSelectionSchema } from "@opensteer/core";

import { filterThreads, formatRelativeTime } from "./thread-list-model.js";
import type { ThreadSummary, WorkspaceSummary } from "./client.js";

const codexModelSelection = ModelSelectionSchema.parse({
  modelId: "gpt-5.6-sol",
  options: { effort: "low" },
  providerId: "openai",
});

const claudeModelSelection = ModelSelectionSchema.parse({
  modelId: "sonnet",
  options: { effort: "high" },
  providerId: "anthropic",
});

const workspaces: WorkspaceSummary[] = [
  {
    description: "Product files",
    homeThreadId: null,
    fileCount: 12,
    harnessLabel: "Codex",
    icon: null,
    id: "workspace_product",
    kind: "specialized" as const,
    machineName: "Main runner",
    name: "Product launch",
    runnerLabel: "Main runner",
    status: "ready",
    storageIssue: null,
    color: "purple",
    updatedAt: "2026-08-09T12:00:00.000Z",
  },
  {
    description: "Finance files",
    homeThreadId: null,
    fileCount: 4,
    harnessLabel: "Claude Code",
    icon: null,
    id: "workspace_finance",
    kind: "specialized" as const,
    machineName: "Local Mac",
    name: "Finance operations",
    runnerLabel: "Local Mac",
    status: "ready",
    storageIssue: null,
    color: "lime",
    updatedAt: "2026-08-08T12:00:00.000Z",
  },
];

const threads: ThreadSummary[] = [
  {
    doneAt: null,
    icon: null,
    color: null,
    accessMode: "full-access",
    role: "work",
    continuationIdentity: null,
    providerSessionId: null,
    createdAt: "2026-08-09T09:00:00.000Z",
    environmentId: "environment_main",
    harnessInstanceId: "harness_codex_main",
    harnessLabel: "Codex",
    id: "thread_older",
    inputQueuePaused: false,
    listed: true,
    modelLabel: "gpt-5.6-sol",
    modelSelection: codexModelSelection,
    parentThreadId: null,
    pendingRequests: 0,
    runnerLabel: "Main runner",
    status: "idle",
    title: "Draft homepage copy",
    unread: false,
    updatedAt: "2026-08-09T09:00:00.000Z",
    workspaceId: "workspace_product",
  },
  {
    doneAt: null,
    icon: null,
    color: null,
    accessMode: "full-access",
    role: "work",
    continuationIdentity: null,
    providerSessionId: null,
    createdAt: "2026-08-09T10:00:00.000Z",
    environmentId: "environment_local",
    harnessInstanceId: "harness_claude",
    harnessLabel: "Claude Code",
    id: "thread_finance",
    inputQueuePaused: false,
    listed: true,
    modelLabel: "sonnet",
    modelSelection: claudeModelSelection,
    parentThreadId: null,
    pendingRequests: 0,
    runnerLabel: "Local Mac",
    status: "waiting",
    title: "Reconcile expenses",
    unread: true,
    updatedAt: "2026-08-09T10:00:00.000Z",
    workspaceId: "workspace_finance",
  },
  {
    doneAt: null,
    icon: null,
    color: null,
    accessMode: "full-access",
    role: "work",
    continuationIdentity: null,
    providerSessionId: null,
    createdAt: "2026-08-09T11:00:00.000Z",
    environmentId: "environment_main",
    harnessInstanceId: "harness_codex_main",
    harnessLabel: "Codex",
    id: "thread_newer",
    inputQueuePaused: false,
    listed: true,
    modelLabel: "gpt-5.6-sol",
    modelSelection: codexModelSelection,
    parentThreadId: null,
    pendingRequests: 0,
    runnerLabel: "Main runner",
    status: "running",
    title: "Prepare launch brief",
    unread: false,
    updatedAt: "2026-08-09T11:00:00.000Z",
    workspaceId: "workspace_product",
  },
];

describe("thread search", () => {
  it.each([
    ["launch", ["thread_older", "thread_newer"]],
    [" FINANCE ", ["thread_finance"]],
    ["claude", ["thread_finance"]],
    ["local mac", ["thread_finance"]],
    ["missing", []],
    ["mac local", ["thread_finance"]],
    ["receipts", ["thread_finance"]],
    ["copy draft", ["thread_older"]],
  ])(
    "searches title, its question, workspace, harness, and runner for %j",
    (query, expectedIds) => {
      const attention = [{ threadId: "thread_finance", title: "Upload the March receipts" }];
      expect(
        filterThreads(threads, workspaces, query, attention).map((thread) => thread.id),
      ).toEqual(expectedIds);
    },
  );
});

describe("display formatting", () => {
  const now = new Date("2026-08-09T20:00:00.000Z");

  it.each([
    ["2026-08-09T19:59:30.000Z", "now"],
    ["2026-08-09T19:42:00.000Z", "18m"],
    ["2026-08-09T17:00:00.000Z", "3h"],
    ["2026-08-07T20:00:00.000Z", "2d"],
    ["2026-08-10T20:00:00.000Z", "now"],
  ])("formats %s as %s", (timestamp, expected) => {
    expect(formatRelativeTime(timestamp, now)).toBe(expected);
  });

  it("falls back to a calendar date after one week and ignores invalid dates", () => {
    expect(formatRelativeTime("2026-07-25T20:00:00.000Z", now)).toBe("Jul 25");
    expect(formatRelativeTime("not-a-date", now)).toBe("");
  });
});
