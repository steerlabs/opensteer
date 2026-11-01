import { describe, expect, it } from "vitest";
import {
  BootstrapNoticeDiagnostics,
  BootstrapReadDiagnostics,
  bootstrapReasons,
  parseBootstrapDiagnosticSummary,
} from "./bootstrapDiagnostics.js";

describe("bootstrap diagnostics", () => {
  it("keeps interval reads and joined triggers quiet, and expires old counts", () => {
    const reads = new BootstrapReadDiagnostics();
    for (let now = 0; now < 300_000; now += 15_000) {
      reads.trigger("interval", now);
      reads.start("interval", now);
      reads.trigger("refresh", now);
      expect(reads.takeSummary()).toBeUndefined();
    }
    reads.start("refresh", 300_000);
    expect(reads.takeSummary()).toBeUndefined();
  });

  it("counts every trigger but only actual reads, retaining the deferred notice's cause", () => {
    const reads = new BootstrapReadDiagnostics();
    for (const reason of bootstrapReasons) reads.trigger(reason, 0);
    for (let index = 0; index < 5; index++) reads.start("host.browser-sessions-changed", index);
    expect(reads.takeSummary()).toBeUndefined();
    reads.start("host.browser-sessions-changed", 5);
    expect(reads.takeSummary()).toEqual({
      windowMs: 5,
      triggers: Object.fromEntries(bootstrapReasons.map((reason) => [reason, 1])),
      starts: { "host.browser-sessions-changed": 6 },
    });
    expect(reads.takeSummary()).toBeUndefined();
    for (let index = 0; index < 100; index++) reads.start("load", 10 + index);
    expect(reads.takeSummary()).toBeUndefined();
    reads.trigger("interval", 60_005);
    reads.start("interval", 60_005);
    expect(reads.takeSummary()).toMatchObject({ starts: { load: 100, interval: 1 } });
  });

  it("keeps ordinary loads separated by more than a minute quiet", () => {
    const reads = new BootstrapReadDiagnostics();
    for (let index = 0; index < 20; index++) {
      reads.trigger("load", index * 61_000);
      reads.start("load", index * 61_000);
      expect(reads.takeSummary()).toBeUndefined();
    }
  });

  it("counts native-profile reconciliation and erasure publications by fixed source", () => {
    const notices = new BootstrapNoticeDiagnostics();
    notices.record("host.browser-sessions-changed", "browser.profile-reconciled", 0);
    notices.record("host.browser-sessions-changed", "browser.profile-deletions", 0);
    const report = notices.report(
      JSON.stringify({
        windowMs: 1,
        triggers: { "host.browser-sessions-changed": 6 },
        starts: { "host.browser-sessions-changed": 6 },
      }),
      1,
    );
    expect(JSON.parse(report!.notices)).toEqual({
      "host.browser-sessions-changed/browser.profile-reconciled": 1,
      "host.browser-sessions-changed/browser.profile-deletions": 1,
    });
  });
  it("reports broad publication types and sources once per minute, without fanout or payloads", () => {
    const notices = new BootstrapNoticeDiagnostics();
    notices.record("host.browser-sessions-changed", "browser.catalog-flush", 0);
    notices.record("host.machines.changed", "computer-apps.status", 59_000);
    notices.record("host.machines.changed", "computer-apps.status", 59_500);
    notices.record("host.browser-tabs-changed", "browser.tabs", 59_500);
    notices.record("private payload", "unspecified", 59_500);
    const summary = JSON.stringify({
      windowMs: 3_600,
      triggers: { "host.machines.changed": 100 },
      starts: { "host.machines.changed": 6 },
    });
    const report = notices.report(summary, 60_000);
    expect(report).toEqual({
      windowMs: 3_600,
      triggers: '{"host.machines.changed":100}',
      starts: '{"host.machines.changed":6}',
      noticeWindowMs: 60_000,
      notices: '{"host.machines.changed/computer-apps.status":2}',
    });
    expect(notices.report(summary, 60_001)).toBeNull();
    expect(notices.report(summary, 120_000)?.notices).toBe("{}");
  });

  it.each([
    undefined,
    "invalid JSON with PRIVATE-VALUE",
    "x".repeat(2049),
    JSON.stringify({ windowMs: 1, triggers: {}, starts: { interval: 100 } }),
    JSON.stringify({ windowMs: 1, triggers: {}, starts: { load: 5 } }),
    JSON.stringify({ windowMs: 60_001, triggers: {}, starts: { load: 6 } }),
    JSON.stringify({ windowMs: 1, triggers: { "https://private.test": 1 }, starts: { load: 6 } }),
    JSON.stringify({ windowMs: 1, triggers: {}, starts: { load: "PRIVATE-VALUE" } }),
    JSON.stringify({ windowMs: 1, triggers: {}, starts: { load: -6 } }),
    JSON.stringify({ windowMs: 1, triggers: {}, starts: { load: 1_000_001 } }),
    JSON.stringify({ windowMs: 1, triggers: {}, starts: { load: 6 }, payload: "PRIVATE-VALUE" }),
  ])("ignores malformed, content-bearing or non-anomalous summaries (%#)", (raw) => {
    expect(parseBootstrapDiagnosticSummary(raw)).toBeNull();
    expect(new BootstrapNoticeDiagnostics().report(raw, 0)).toBeNull();
  });
});
