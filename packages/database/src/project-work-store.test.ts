import { createId } from "@opensteer/core";
import { expect, it } from "vitest";
import { projectExchangeKey, type ProjectExchange } from "./project-work-store.js";

it("separates every captured human-root incarnation and the assignment in a Project exchange", () => {
  const exchange = {
    project: {
      kind: "project",
      workspaceId: createId("workspace"),
      principalId: "project-principal",
    },
    threadId: createId("thread"),
    assignmentId: null,
    replyTarget: null,
    origin: {
      userId: createId("user"),
      initiatorGeneration: 2,
      membershipGeneration: 3,
      originConnectionId: null,
    },
  } satisfies ProjectExchange;
  const key = projectExchangeKey(exchange);
  const changed: ProjectExchange[] = [
    { ...exchange, origin: { ...exchange.origin, userId: createId("user") } },
    { ...exchange, origin: { ...exchange.origin, initiatorGeneration: 3 } },
    { ...exchange, origin: { ...exchange.origin, membershipGeneration: 4 } },
    { ...exchange, origin: { ...exchange.origin, originConnectionId: "connection" } },
    { ...exchange, threadId: createId("thread") },
    { ...exchange, project: { ...exchange.project, workspaceId: createId("workspace") } },
    { ...exchange, project: { ...exchange.project, principalId: "replacement-principal" } },
    { ...exchange, assignmentId: createId("delegation") },
  ];
  expect(changed.map(projectExchangeKey)).not.toContain(key);
  expect(projectExchangeKey({ ...exchange, origin: { ...exchange.origin } })).toBe(key);
});

it("separates unattended sources and their incarnations instead of grouping null roots", () => {
  const exchange = {
    project: {
      kind: "project",
      workspaceId: createId("workspace"),
      principalId: "project-principal",
    },
    threadId: createId("thread"),
    assignmentId: null,
    replyTarget: null,
    origin: null,
    source: { kind: "watch", id: "activation", incarnation: "revision-1:generation-1" },
  } satisfies ProjectExchange;
  const keys = [
    projectExchangeKey(exchange),
    projectExchangeKey({ ...exchange, source: { ...exchange.source, id: "another-activation" } }),
    projectExchangeKey({
      ...exchange,
      source: { ...exchange.source, incarnation: "revision-1:generation-2" },
    }),
    projectExchangeKey({ ...exchange, source: { ...exchange.source, kind: "trigger" } }),
  ];
  expect(new Set(keys).size).toBe(keys.length);
});
