import { randomUUID } from "node:crypto";
import { createId, type TriggerId, type UserId } from "@opensteer/core";
import {
  createDatabase,
  migrateToLatest,
  OpensteerStore,
  personTaskReader,
  TriggerStore,
} from "@opensteer/database";
import { cloneTestDatabase, type TestDatabase } from "@opensteer/database/test-support/database";
import { seedPersonalFixture } from "@opensteer/database/test-support/personal";
import { loadReleasedHome } from "@opensteer/database/test-support/released-home";
import Fastify from "fastify";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostAuthenticator } from "../identity/auth.js";
import { registerTriggerRoutes } from "./trigger-routes.js";
import { TriggerService } from "./trigger-service.js";

let clone: TestDatabase;
let database: ReturnType<typeof createDatabase>;
const apps: ReturnType<typeof Fastify>[] = [];
const model = '{"providerId":"openai","modelId":"fixture","options":{}}';

beforeEach(async () => {
  clone = await cloneTestDatabase("host");
  database = createDatabase({ connectionString: clone.url });
  // Main's last migration, as main's own code made it.
  await loadReleasedHome(clone.url);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  try {
    await database?.destroy();
  } finally {
    await clone?.drop();
  }
});

async function seedMainTask(title: string) {
  const owner = await seedPersonalFixture(database, "/tmp/webhook-address-migration-fixture");
  const thread = createId("thread");
  const harness = createId("harnessInstance");
  const {
    rows: [principal],
  } = await sql<{ id: string }>`
    select id from principals where user_id = ${owner.userId}
  `.execute(database);
  await sql`insert into harness_instances
    (id, environment_id, driver_kind, name, config, runtime_revision, state_kind, enabled, is_default, source_id)
    values (${harness}, ${owner.environmentId}, 'codex', 'Codex', '{}', 1, 'ready', true, true, 'native')
  `.execute(database);
  await sql`insert into threads
    (id, lineage_root_thread_id, purpose, listed, title, icon_source, color, environment_id,
     harness_instance_id, model_selection, created_by, created_by_principal_id)
    values (${thread}, ${thread}, 'task', true, ${title}, 'default', 'blue', ${owner.environmentId},
            ${harness}, ${model}::jsonb, ${owner.userId}, ${principal!.id})
  `.execute(database);
  return { ...owner, thread, harness, principal: principal!.id };
}

it("rotates a main-era webhook address in 0113 so the old address reads like an unknown address and the new one fires", async () => {
  const home = await seedMainTask("Webhook migration");
  const triggerId = createId("trigger");
  const revisionId = `trv_${randomUUID()}`;
  const oldRouteKey = "wh_legacy0123456789abcdef0123456789ab";
  const source = "export default async function ({ event }) { return event.payload; }";
  const program = JSON.stringify({
    language: "typescript",
    source,
    toolContractVersion: 5,
  });

  await database.transaction().execute(async (tx) => {
    await sql`insert into triggers
      (id, anchor_thread_id, created_by, idempotency_key, request_fingerprint, name, kind, status,
       current_revision_id, consecutive_failures, webhook_route_key, webhook_secret_hash)
      values (${triggerId}, ${home.thread}, ${home.userId}, 'main-webhook', 'fp-main-wh',
        'Main webhook', 'webhook', 'active', ${revisionId}, 0, ${oldRouteKey}, 'synthetic-main-secret-hash')
    `.execute(tx);
    await sql`insert into trigger_revisions(id, trigger_id, ordinal, source, program, created_by)
      values (${revisionId}, ${triggerId}, 1, '{"kind":"webhook"}'::jsonb, ${program}::jsonb, ${home.userId})
    `.execute(tx);
  });

  const oldCommandId = createId("command");
  const oldOccId = `toc_${randomUUID()}`;
  await sql`insert into commands
    (id, environment_id, thread_id, requested_by, actor_principal_id, authority_source,
     idempotency_key, type, payload, status)
    values (${oldCommandId}, ${home.environmentId}, ${home.thread}, ${home.userId},
      ${home.principal}, '{"kind":"person"}'::jsonb, 'main-wh-occ', 'trigger.execute', '{}'::jsonb, 'succeeded')
  `.execute(database);
  const oldEvent = JSON.stringify({
    id: oldOccId,
    payload: null,
    receivedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "webhook", method: "POST", headers: {}, query: {}, path: "/hooks/v1" },
    trigger: { anchorThreadId: home.thread, id: triggerId, revisionId },
  });
  await sql`insert into trigger_occurrences
    (id, trigger_id, revision_id, command_id, environment_id, source_key, event, status, stdout, stderr)
    values (${oldOccId}, ${triggerId}, ${revisionId}, ${oldCommandId}, ${home.environmentId},
      'webhook:old', ${oldEvent}::jsonb, 'succeeded', 'prior webhook output', '')
  `.execute(database);

  await migrateToLatest(database);

  await database
    .updateTable("runners")
    .set({
      capabilities: sql`(select jsonb_agg(distinct value) from jsonb_array_elements_text(capabilities || '["automation-script-v1"]'::jsonb))`,
    } as never)
    .where("id", "=", home.runnerId)
    .execute();

  const hostStore = new OpensteerStore(database);
  const triggerStore = new TriggerStore(database);
  const triggers = new TriggerService({
    onOccurrenceQueued: vi.fn(),
    publicUrl: new URL("https://home.opensteer.test"),
    runnerStore: hostStore,
    store: triggerStore,
    threads: hostStore,
  });

  // 1. Read migrated state, replace the legacy program with a script, and resume as the product does.
  const migrated = await triggers.get(home.userId as UserId, triggerId, 25, personTaskReader);
  const newRouteKey = migrated.trigger.webhookRouteKey;

  const updated = await triggers.update(
    home.userId as UserId,
    {
      expectedRevisionId: migrated.revision.id,
      script: { interpreter: null, text: "console.log('migrated-ok');" },
      triggerId,
    },
    null,
  );
  const resumed = await triggers.setStatus(
    home.userId as UserId,
    { status: "active", triggerId },
    null,
  );

  // 2. Call the real webhook HTTP route with the OLD address vs an unknown address vs the NEW address.
  const app = Fastify();
  apps.push(app);
  registerTriggerRoutes(app, {} as HostAuthenticator, triggers);

  const unknownRouteKey = "whk_unknown0123456789abcdef0123456789abcdef012";
  const [oldResponse, unknownResponse] = await Promise.all([
    app.inject({
      method: "POST",
      payload: JSON.stringify({ from: "old-caller" }),
      headers: { "content-type": "application/json" },
      url: `/hooks/v1/${oldRouteKey}`,
    }),
    app.inject({
      method: "POST",
      payload: JSON.stringify({ from: "unknown-caller" }),
      headers: { "content-type": "application/json" },
      url: `/hooks/v1/${unknownRouteKey}`,
    }),
  ]);

  expect(unknownResponse.statusCode).toBe(404);
  expect(unknownResponse.json()).toEqual({
    error: { code: "not_found", message: "Webhook not found" },
  });
  expect(oldResponse.statusCode).toBe(unknownResponse.statusCode);
  expect(oldResponse.json()).toEqual(unknownResponse.json());

  const beforeNewHit = await database
    .selectFrom("triggerOccurrences")
    .select("id")
    .where("triggerId", "=", triggerId)
    .execute();
  expect(beforeNewHit).toHaveLength(1);

  expect(newRouteKey).toMatch(/^whk_[A-Za-z0-9_-]{43}$/u);
  expect(newRouteKey).not.toBe(oldRouteKey);
  expect(migrated.webhook?.url).toBe(`https://home.opensteer.test/hooks/v1/${newRouteKey}`);

  const newResponse = await app.inject({
    method: "POST",
    payload: JSON.stringify({ from: "new-caller" }),
    headers: { "content-type": "application/json" },
    url: `/hooks/v1/${newRouteKey}`,
  });
  expect(newResponse.statusCode).toBe(202);
  expect(newResponse.json()).toMatchObject({
    occurrenceId: expect.any(String),
    wasDuplicate: false,
  });

  const afterNewHit = await database
    .selectFrom("triggerOccurrences")
    .select("id")
    .where("triggerId", "=", triggerId)
    .execute();
  expect(afterNewHit).toHaveLength(2);

  // 3. Verify pause reason, address visibility, and preserved source/output/metadata across upgrade -> repair -> resume.
  expect(migrated.trigger.status).toBe("paused");
  expect(migrated.trigger.pauseReason).toBe(
    "Needs an update: ask your agent. Its webhook address was replaced, so update anything that calls it with the new address.",
  );
  expect(migrated.revision.legacySource).toBe(source);
  expect(migrated.revision.legacyLanguage).toBe("typescript");
  expect(migrated.revision.legacyToolContractVersion).toBe(5);
  expect(migrated.occurrences[0]?.stdout).toBe("prior webhook output");
  expect(updated.trigger.status).toBe("paused");
  expect(updated.trigger.pauseReason).toBe(
    "Its webhook address was replaced, so update anything that calls it with the new address.",
  );
  expect(resumed.status).toBe("active");
  expect(resumed.pauseReason).toBeNull();
});

it("gives two main-era webhooks distinct addresses, rotates already-paused ones, and leaves non-webhooks and branch-format webhooks untouched", async () => {
  const home = await seedMainTask("Webhook batch");
  const webhookA = createId("trigger");
  const revA = `trv_${randomUUID()}`;
  const webhookB = createId("trigger");
  const revB = `trv_${randomUUID()}`;
  const scheduleId = createId("trigger");
  const revSched = `trv_${randomUUID()}`;
  const branchWebhook = createId("trigger");
  const revBranch = `trv_${randomUUID()}`;

  const oldKeyA = "wh_legacyA0123456789abcdef0123456789ab";
  const oldKeyB = "wh_legacyB0123456789abcdef0123456789ab";
  const branchKey = `whk_${"B".repeat(43)}`;
  const program = JSON.stringify({
    language: "javascript",
    source: "export default () => ({ ok: true });",
    toolContractVersion: 5,
  });
  const scheduleSource = JSON.stringify({
    kind: "schedule",
    schedule: { kind: "cron", expression: "0 9 * * *", timezone: "UTC" },
  });

  await database.transaction().execute(async (tx) => {
    await sql`insert into triggers
      (id, anchor_thread_id, created_by, idempotency_key, request_fingerprint, name, kind, status,
       current_revision_id, consecutive_failures, webhook_route_key, webhook_secret_hash)
      values
        (${webhookA}, ${home.thread}, ${home.userId}, 'wh-a', 'fp-a', 'Webhook A', 'webhook', 'active', ${revA}, 0, ${oldKeyA}, 'hash-a'),
        (${webhookB}, ${home.thread}, ${home.userId}, 'wh-b', 'fp-b', 'Webhook B', 'webhook', 'paused', ${revB}, 0, ${oldKeyB}, 'hash-b'),
        (${scheduleId}, ${home.thread}, ${home.userId}, 'sched', 'fp-s', 'Morning schedule', 'schedule', 'active', ${revSched}, 0, null, null),
        (${branchWebhook}, ${home.thread}, ${home.userId}, 'wh-branch', 'fp-br', 'Branch webhook', 'webhook', 'active', ${revBranch}, 0, ${branchKey}, null)
    `.execute(tx);
    await sql`insert into trigger_revisions(id, trigger_id, ordinal, source, program, created_by)
      values
        (${revA}, ${webhookA}, 1, '{"kind":"webhook"}'::jsonb, ${program}::jsonb, ${home.userId}),
        (${revB}, ${webhookB}, 1, '{"kind":"webhook"}'::jsonb, ${program}::jsonb, ${home.userId}),
        (${revSched}, ${scheduleId}, 1, ${scheduleSource}::jsonb, ${program}::jsonb, ${home.userId}),
        (${revBranch}, ${branchWebhook}, 1, '{"kind":"webhook"}'::jsonb, ${program}::jsonb, ${home.userId})
    `.execute(tx);
  });

  await migrateToLatest(database);

  const rows = new Map(
    (
      await sql<{
        id: TriggerId;
        status: string;
        pauseReason: string | null;
        webhookRouteKey: string | null;
      }>`select id, status, pause_reason, webhook_route_key from triggers`.execute(database)
    ).rows.map((row) => [row.id, row]),
  );

  const rowA = rows.get(webhookA)!;
  const rowB = rows.get(webhookB)!;
  const rowSched = rows.get(scheduleId)!;
  const rowBranch = rows.get(branchWebhook)!;

  expect(rowA.webhookRouteKey).toMatch(/^whk_[A-Za-z0-9_-]{43}$/u);
  expect(rowB.webhookRouteKey).toMatch(/^whk_[A-Za-z0-9_-]{43}$/u);
  expect(rowA.webhookRouteKey).not.toBe(oldKeyA);
  expect(rowB.webhookRouteKey).not.toBe(oldKeyB);
  expect(rowA.webhookRouteKey).not.toBe(rowB.webhookRouteKey);
  expect(rowA.status).toBe("paused");
  expect(rowB.status).toBe("paused");
  expect(rowA.pauseReason).toMatch(/address was replaced/iu);
  expect(rowB.pauseReason).toMatch(/address was replaced/iu);

  expect(rowSched.webhookRouteKey).toBeNull();
  expect(rowSched.status).toBe("paused");
  expect(rowSched.pauseReason).toBe("Needs an update: ask your agent");

  expect(rowBranch.webhookRouteKey).toBe(branchKey);
  expect(rowBranch.pauseReason).toBe("Needs an update: ask your agent");
});
