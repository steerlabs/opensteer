#!/usr/bin/env node
/**
 * Maersk Container Tracking — Akamai-bypassing scraper
 *
 * Reverse-engineered API:
 *   GET https://api.maersk.com/synergy/tracking/{trackingId}?operator=MAEU
 *
 * Why direct HTTP replay fails:
 *   Akamai Bot Manager injects a per-request `akamai-bm-telemetry` header via
 *   a page-level `window.fetch` monkey-patch. Opensteer's session-http transport
 *   uses `browserContext.request.fetch()` which bypasses that interceptor → 403.
 *
 * Bypass strategy:
 *   Navigate the real browser directly to the tracking result URL. The page's own
 *   JS makes the API call with fresh Akamai telemetry. We capture the response
 *   from network traffic — no UI interaction, no header replay.
 *
 * Usage:
 *   node maersk-tracker.mjs [TRACKING_ID ...]
 *
 * Requires Chrome with remote debugging:
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 */

import { execSync } from "node:child_process";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const trackingIds = process.argv.slice(2);
if (trackingIds.length === 0) trackingIds.push("TCLU2352246");

const SESSION = "maersk-tracker";
const CWD = import.meta.dirname;

function cli(cmd) {
  const full = `pnpm opensteer:local ${cmd} --name "${SESSION}"`;
  return execSync(full, { cwd: CWD, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
}

function cliJson(cmd) {
  const out = cli(cmd);
  const lines = out.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  throw new Error(`Failed to parse CLI output for: ${cmd}`);
}

function cliJsonToFile(cmd) {
  const tmp = join(tmpdir(), `maersk-${Date.now()}.json`);
  cli(`${cmd} --output ${tmp}`);
  const data = JSON.parse(readFileSync(tmp, "utf-8"));
  unlinkSync(tmp);
  return data;
}

async function fetchTracking(trackingId) {
  // Clear prior network traffic
  cliJson("network clear");

  // Navigate directly to the tracking result URL.
  // The page's own JS fires the API call with proper Akamai telemetry.
  cliJson(`goto "https://www.maersk.com/tracking/${trackingId}"`);

  // Wait for the page's JS to complete the API call
  await new Promise((r) => setTimeout(r, 3000));

  // Capture the API response from network traffic
  const netData = cliJsonToFile("network query --resource-type fetch --include-bodies");
  const record = netData.records?.find(
    (r) => r.record?.url?.includes("synergy/tracking"),
  );

  if (!record) {
    console.error(`  No tracking API response found for ${trackingId}`);
    return null;
  }

  const rec = record.record;
  if (rec.status !== 200) {
    console.error(`  API returned status ${rec.status} for ${trackingId}`);
    return null;
  }

  // Decode base64-wrapped response
  const body = rec.responseBody;
  if (body?.data) {
    return JSON.parse(Buffer.from(body.data, "base64").toString("utf-8"));
  }
  if (typeof body === "string") {
    const parsed = JSON.parse(body);
    return parsed.data
      ? JSON.parse(Buffer.from(parsed.data, "base64").toString("utf-8"))
      : parsed;
  }
  return body;
}

function printTracking(trackingId, data) {
  const o = data.origin;
  const d = data.destination;
  const c = data.containers?.[0];

  console.log("=".repeat(60));
  console.log(`  ${trackingId}`);
  console.log("=".repeat(60));
  console.log(`  Origin:      ${o?.city}, ${o?.country} — ${o?.terminal}`);
  console.log(`  Destination: ${d?.city}, ${d?.country} — ${d?.terminal}`);
  console.log(`  Last Update: ${data.last_update_time}`);

  if (c) {
    console.log(`  Container:   ${c.container_size}ft ${c.container_type} (${c.iso_code})`);
    const events = c.locations?.flatMap((loc) =>
      (loc.events || []).map((e) => ({ ...e, loc: `${loc.city}, ${loc.country}` })),
    ) || [];
    console.log(`\n  ${events.length} events:`);
    for (const e of events) {
      const t = e.event_time?.replace("T", " ").replace(".000", "");
      const v = e.vessel_name ? ` [${e.vessel_name} ${e.voyage_num}]` : "";
      console.log(`  ${t}  ${e.activity.padEnd(22)} ${e.loc}${v}`);
    }
  }
  console.log();
}

async function main() {
  // Open a browser session (attach to running Chrome with remote debugging)
  cliJson(`open "https://www.maersk.com/tracking" --browser auto-connect --fresh-tab`);

  try {
    for (const id of trackingIds) {
      const data = await fetchTracking(id);
      if (data) {
        printTracking(id, data);
        const outFile = join(CWD, `tracking-${id}.json`);
        writeFileSync(outFile, JSON.stringify(data, null, 2));
        console.log(`  Saved: ${outFile}\n`);
      }
    }
  } finally {
    cliJson("close");
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  try { cliJson("close"); } catch {}
  process.exit(1);
});
