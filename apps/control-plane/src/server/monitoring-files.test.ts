import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { accountEvents } from "./events.js";

const root = join(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const files = (directory: string) =>
  readdirSync(join(root, directory))
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => ({ name, text: read(`${directory}/${name}`) }));

/** Every event name a service writes: the account's table, the provisioner's, the synthetic run's. */
function writtenEvents(): Set<string> {
  const provisioner = read("apps/home-provisioner/src/http.ts").match(
    /"home-provisioner\.[a-z.-]+"/gu,
  );
  const synthetic = read("scripts/synthetic-cloud-computer.mjs").match(
    /"synthetic\.run\.[a-z]+"/gu,
  );
  return new Set([
    ...Object.keys(accountEvents),
    ...[...(provisioner ?? []), ...(synthetic ?? [])].map((name) => name.slice(1, -1)),
  ]);
}

describe("deploy/monitoring", () => {
  const policies = files("deploy/monitoring/policies");
  const metrics = files("deploy/monitoring/metrics");
  const runbook = read("docs/cloud-computer-operations.md");

  it("alerts only on events a service writes, each with its reason and an existing runbook section", () => {
    const written = writtenEvents();
    expect(policies.length).toBeGreaterThanOrEqual(10);
    for (const { name, text } of [...policies, ...metrics]) {
      for (const [, event] of text.matchAll(/jsonPayload\.event="([^"]+)"/gu))
        expect(written, `${name} names ${event}`).toContain(event);
      if (name.startsWith("page-") || name.startsWith("digest-")) {
        expect(text.split("\n")[0], name).toMatch(/^# [A-Z].*\.$/u);
        const section = /^# Runbook: docs\/cloud-computer-operations\.md, "([^"]+)"\.$/mu.exec(
          text,
        )?.[1];
        expect(section, name).toBeDefined();
        expect(runbook, `${name}: "${section}"`).toContain(`### ${section}\n`);
      }
    }
  });

  it("pages for three things and sends the rest to the digest", () => {
    const pages = policies.filter(({ name }) => name.startsWith("page-"));
    expect(pages.map(({ name }) => name).sort()).toEqual([
      "page-account-down.yaml",
      "page-paid-not-ready.yaml",
      "page-synthetic-failed-twice.yaml",
    ]);
    for (const { name, text } of policies) {
      const page = name.startsWith("page-");
      expect(text, name).toContain(page ? "severity: CRITICAL" : "severity: WARNING");
      expect(text, name).toContain(`opensteer_alert: ${page ? "page" : "digest"}`);
      if (!page) expect(text, name).toContain("period: 86400s");
    }
  });

  it("covers the event that matters most and every runbook failure the account names", () => {
    const alerted = new Set(
      policies.flatMap(({ text }) =>
        [...text.matchAll(/jsonPayload\.event="([^"]+)"/gu)].map(([, event]) => event),
      ),
    );
    const unalerted = Object.keys(accountEvents).filter(
      (event) => !alerted.has(event) && event !== "account.heartbeat.failed",
    );
    expect(unalerted).toEqual([]);
  });
});
