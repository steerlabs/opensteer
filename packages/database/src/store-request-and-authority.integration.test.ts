import {
  DeviceIdSchema,
  createId,
  emptyExecutionPreferences,
  HarnessIdSchema,
  ModelSelectionSchema,
  RequestViewSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import { createBrowserSessionId, HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import { OpensteerStore } from "./index.js";
import {
  describeStore,
  testContinuationIdentity,
  writeBrowserUsageArtifact,
} from "./store.integration.test-support.js";
describeStore("PostgreSQL store", (it) => {
  it("records only the winning human Passwords session and refuses revoked sessions", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, database } = storeFixture;
    const fixture = await startRunFixture("password-settlement-provenance");
    const sessionId = createId("authSession");
    const now = new Date();
    await database
      .insertInto("authSessions")
      .values({
        id: sessionId,
        userId: fixture.userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
        ipAddress: null,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Version/19.0 Mobile Safari/604.1",
        deviceLabel: "old unsafe label",
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    const open = async (suffix: string) =>
      store.requests.openPasswordSignIn({
        callId: suffix,
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        kind: "browser.password-sign-in",
        mode: "durable",
        payload: {
          kind: "browser.password-sign-in",
          operationId: randomUUID(),
          scope: "personal",
          permissionVersion: 6,
          runnerId: fixture.runnerId,
          computerName: "Test Mac",
          reason: "Sign in",
          site: "https://example.com",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        presentation: {
          kind: "external",
          title: "Sign in",
          subject: {
            kind: "browser-site",
            id: "https://example.com",
          },
        },
      });
    const first = await open("first");
    const input = {
      ownerId: fixture.userId,
      requestId: first.request.id,
      settlementSessionId: sessionId,
      settlement: {
        status: "declined" as const,
      },
    };
    const result = await store.requests.settlePasswordSignInRequest(input);
    expect(result?.request.settlementProvenance).toEqual({
      sessionId,
      deviceLabel: "Safari on iPhone",
    });
    const approved = await open("approved");
    const consent = await store.requests.settlePasswordSignInRequest({
      ...input,
      requestId: approved.request.id,
      settlement: {
        status: "fulfilled",
        response: {
          outcome: "authorized",
          account: "a•••",
        },
      },
    });
    await database.deleteFrom("authSessions").where("id", "=", sessionId).execute();
    const interruption = {
      ownerId: fixture.userId,
      requestId: approved.request.id,
      settlement: {
        status: "fulfilled",
        response: {
          outcome: "interrupted",
        },
      },
    } as const;
    const interrupted = await store.requests.settlePasswordSignInRequest(interruption);
    expect(interrupted?.request).toMatchObject({
      status: "fulfilled",
      response: {
        kind: "external",
        value: {
          outcome: "interrupted",
        },
      },
      settlementProvenance: consent?.request.settlementProvenance,
      resolvedAt: consent?.request.resolvedAt,
      resolvedBy: consent?.request.resolvedBy,
    });
    expect(consent?.request).toMatchObject({
      response: { kind: "external", value: { outcome: "authorized", account: "a•••" } },
      settlementProvenance: { sessionId, deviceLabel: "Safari on iPhone" },
    });
    expect(await store.requests.settlePasswordSignInRequest(interruption)).toBeNull();
    expect(
      await store.requests.settlePasswordSignInRequest({
        ...input,
        requestId: approved.request.id,
        settlement: {
          status: "fulfilled",
          response: {
            outcome: "authorized",
            account: "other",
          },
        },
      }),
    ).toBeNull();
    expect(
      await database
        .selectFrom("requestContinuations")
        .select("requestId")
        .where("requestId", "=", approved.request.id)
        .execute(),
    ).toHaveLength(1);
    expect(await store.requests.settlePasswordSignInRequest(input)).toBeNull();
    expect((await store.requests.get(first.request.id))?.settlementProvenance).toEqual(
      result?.request.settlementProvenance,
    );
    const second = await open("second");
    await expect(
      store.requests.settlePasswordSignInRequest({
        ...input,
        requestId: second.request.id,
      }),
    ).rejects.toThrow("no longer signed in");
    expect((await store.requests.get(second.request.id))?.status).toBe("pending");
    const automatic = await store.requests.settlePasswordSignInRequest({
      ownerId: fixture.userId,
      requestId: second.request.id,
      settlement: {
        status: "fulfilled",
        response: {
          outcome: "expired",
        },
      },
    });
    expect(automatic?.request.settlementProvenance).toBeNull();
  });
  it("keeps Occurrence Request resolution compatible with Trigger inbox admission", async ({
    storeFixture,
  }) => {
    const {
      startRunFixture,
      startTriggerOccurrence,
      createTaskForOwner,
      store,
      stagedRequestRace,
    } = storeFixture;
    const fixture = await startRunFixture("request-occurrence-fk-race");
    const occurrence = await startTriggerOccurrence(fixture, "request-occurrence-fk-race");
    const target = await createTaskForOwner(fixture.userId, "request-occurrence-fk-target");
    const opened = await store.requests.create({
      callId: "request-occurrence-fk-race",
      kind: "browser.access",
      mode: "durable",
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: fixture.thread.id,
      requestedBy: fixture.userId,
      requiredActor: "requester",
      payload: {
        kind: "browser.access",
        reason: "Choose a profile",
        suggestion: {
          kind: "user_choice",
        },
      },
      presentation: {
        kind: "external",
        title: "Choose browser access",
        subject: {
          id: target.id,
          kind: "thread",
        },
      },
    });
    const results = await stagedRequestRace(
      (transaction) =>
        transaction
          .selectFrom("requests")
          .select("id")
          .where("id", "=", opened.request.id)
          .forUpdate()
          .execute(),
      async () =>
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
          expectedRevision: (await store.requests.revision(opened.request.id))!,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: {
              decision: "declined",
            },
          },
        }),
      () =>
        store.enqueueThreadInput({
          content: [
            {
              type: "text",
              text: "Trigger report",
            },
          ],
          idempotencyKey: "request-occurrence-fk-race",
          policy: "report",
          requestedBy: fixture.userId,
          source: {
            kind: "trigger",
            occurrenceId: occurrence.id,
          },
          threadId: fixture.thread.id,
        }),
    );
    expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
    expect(results[0]).toMatchObject({
      value: {
        request: {
          status: "declined",
          originatingOccurrenceId: occurrence.id,
        },
      },
    });
  });
  it("serializes durable Request withdrawal behind the resolution event", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createTaskForOwner, store, database } = storeFixture;
    const fixture = await startRunFixture("request-withdrawal-state-race");
    const target = await createTaskForOwner(fixture.userId, "request_withdrawal_state_race");
    const opened = await store.requests.create({
      callId: "request-withdrawal-state-race",
      kind: "browser.access",
      mode: "durable",
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      payload: {
        kind: "browser.access",
        reason: "Choose a profile",
        suggestion: {
          kind: "user_choice",
        },
      },
      presentation: {
        kind: "external",
        subject: {
          id: target.id,
          kind: "thread",
        },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester",
    });
    let releaseThread!: () => void;
    const releaseSignal = new Promise<void>((resolve) => {
      releaseThread = resolve;
    });
    let announceThread!: () => void;
    const threadLocked = new Promise<void>((resolve) => {
      announceThread = resolve;
    });
    const blocker = database.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("threads")
        .select("id")
        .where("id", "=", fixture.thread.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      announceThread();
      await releaseSignal;
    });
    await threadLocked;
    const waitForWaiters = (count: number) =>
      expect
        .poll(async () => {
          const result = await sql<{
            readonly waiting: number;
          }>`
        select count(*)::integer as waiting from pg_stat_activity
        where datname = current_database()
          and application_name = 'opensteer-integration-test'
          and wait_event_type = 'Lock'
      `.execute(database);
          return Number(result.rows[0]?.waiting ?? 0);
        })
        .toBeGreaterThanOrEqual(count);
    const resolving = store.requests.resolveBrowserRequest({
      requestId: opened.request.id,
      expectedRevision: (await store.requests.revision(opened.request.id))!,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          decision: "declined",
        },
      },
    });
    void resolving.catch(() => undefined);
    const withdrawing = (async () => {
      await waitForWaiters(1);
      return store.requests.withdraw({
        requestId: opened.request.id,
        threadId: fixture.thread.id,
        withdrawnBy: fixture.userId,
      });
    })();
    void withdrawing.catch(() => undefined);
    try {
      await waitForWaiters(2);
    } finally {
      releaseThread();
      await blocker;
    }
    const [resolution, withdrawal] = await Promise.allSettled([resolving, withdrawing]);
    expect(resolution).toMatchObject({
      status: "fulfilled",
      value: {
        request: {
          status: "declined",
        },
      },
    });
    expect(withdrawal).toMatchObject({
      status: "rejected",
      reason: {
        code: "conflict",
      },
    });
    await expect(store.getThreadForOwner(fixture.thread.id, fixture.userId)).resolves.toMatchObject(
      {
        pendingRequests: 0,
      },
    );
    await expect(
      database
        .selectFrom("threads")
        .select("pendingRequestCount")
        .where("id", "=", fixture.thread.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      pendingRequestCount: 0,
    });
  });
  it("opens, replays, and withdraws a durable Request that originates from a Trigger Occurrence", async ({
    storeFixture,
  }) => {
    const { startRunFixture, createTaskForOwner, startTriggerOccurrence, store } = storeFixture;
    const fixture = await startRunFixture("request-trigger-origin");
    const targetWorkspace = await createTaskForOwner(
      fixture.userId,
      "request_trigger_origin_target",
    );
    const occurrence = await startTriggerOccurrence(fixture, "request-trigger-origin");
    const input = {
      callId: "trigger-browser-access-call-1",
      kind: "browser.access" as const,
      mode: "durable" as const,
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: fixture.thread.id,
      payload: {
        kind: "browser.access" as const,
        reason: "The schedule needs the signed-in browser profile",
        suggestion: {
          kind: "user_choice" as const,
        },
      },
      presentation: {
        kind: "external" as const,
        subject: {
          id: targetWorkspace.id,
          kind: "thread",
        },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
    };
    const created = await store.requests.create(input);
    const replay = await store.requests.create(input);
    expect(created).toMatchObject({
      replayed: false,
      request: {
        originatingOccurrenceId: occurrence.id,
        originatingRunId: null,
        status: "pending",
      },
    });
    expect(replay).toMatchObject({
      replayed: true,
      request: {
        id: created.request.id,
      },
    });
    await expect(
      store.requests.findByCallIdentity({
        callId: input.callId,
        originatingOccurrenceId: occurrence.id,
      }),
    ).resolves.toMatchObject({
      id: created.request.id,
    });
    // The same call identity under the Run origin is a different Request.
    await expect(
      store.requests.findByCallIdentity({
        callId: input.callId,
        originatingRunId: fixture.run.id,
      }),
    ).resolves.toBeNull();
    const { originatingOccurrenceId: _occurrenceOrigin, ...runOriginInput } = input;
    await expect(
      store.requests.create({
        ...runOriginInput,
        originatingRunId: fixture.run.id,
      }),
    ).resolves.toMatchObject({
      replayed: false,
      request: {
        originatingRunId: fixture.run.id,
      },
    });
    const withdrawn = await store.requests.withdraw({
      requestId: created.request.id,
      threadId: fixture.thread.id,
      withdrawnBy: fixture.userId,
    });
    expect(withdrawn).toMatchObject({
      replayed: false,
      request: {
        status: "withdrawn",
      },
    });
  });

  it("refuses a Trigger-originated Request whose Occurrence is not the one that is running", async ({
    storeFixture,
  }) => {
    const { startRunFixture, store, startTriggerOccurrence } = storeFixture;
    const fixture = await startRunFixture("request-trigger-authority");
    const otherOwner = await store.createUser("Other trigger owner");
    const occurrence = await startTriggerOccurrence(fixture, "request-trigger-authority");
    const input = {
      callId: "trigger-authority-call-1",
      kind: "device.access" as const,
      mode: "durable" as const,
      originatingThreadId: fixture.thread.id,
      payload: {
        access: "files" as const,
        kind: "device.access" as const,
        machineId: DeviceIdSchema.parse(fixture.runnerId),
        machineName: "Studio Mac",
        reason: "The schedule needs it",
      },
      presentation: {
        kind: "choice" as const,
        options: [
          {
            hint: "confirm" as const,
            id: "allowed",
            label: "Allow",
          },
        ],
        title: "Allow files?",
      },
      requestedBy: fixture.userId,
      requiredActor: "owner" as const,
    };
    await expect(
      store.requests.create({
        ...input,
        originatingOccurrenceId: createId("triggerOccurrence"),
      }),
    ).rejects.toThrow("Trigger Occurrence authority");
    await expect(
      store.requests.create({
        ...input,
        originatingOccurrenceId: occurrence.id,
        requestedBy: otherOwner,
      }),
    ).rejects.toThrow("Trigger Occurrence authority");
  });
  it("holds the Request origin invariants in the schema itself", async ({ storeFixture }) => {
    const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
    const fixture = await startRunFixture("request-origin-constraints");
    const occurrence = await startTriggerOccurrence(fixture, "request-origin-constraints");
    const insertRequest = (values: {
      readonly callId: string;
      readonly mode: "durable" | "live";
      readonly occurrenceId: string | null;
      readonly runId: string | null;
    }) =>
      database
        .insertInto("requests")
        .values({
          callId: values.callId,
          cancellationReason: null,
          createdAt: new Date(),
          id: createId("request"),
          kind: values.mode === "live" ? "harness.approval" : "device.access",
          mode: values.mode,
          originatingOccurrenceId: values.occurrenceId as never,
          originatingRunId: values.runId as never,
          originatingThreadId: fixture.thread.id,
          payload: sql`${JSON.stringify({
            kind: "device.access",
          })}::jsonb`,
          presentation: sql`${JSON.stringify({
            kind: "choice",
            options: [],
            title: "x",
          })}::jsonb`,
          requestedBy: fixture.userId,
          requiredActor: "owner",
          resolvedAt: null,
          resolvedBy: null,
          response: null,
          status: "pending",
        })
        .execute();

    // Exactly one origin, never both and never neither.
    await expect(
      insertRequest({
        callId: "both",
        mode: "durable",
        occurrenceId: occurrence.id,
        runId: fixture.run.id,
      }),
    ).rejects.toThrow("requests_origin_check");
    await expect(
      insertRequest({
        callId: "neither",
        mode: "durable",
        occurrenceId: null,
        runId: null,
      }),
    ).rejects.toThrow("requests_origin_check");
    // A live Request is answered back into the Run that opened it.
    await expect(
      insertRequest({
        callId: "live",
        mode: "live",
        occurrenceId: occurrence.id,
        runId: null,
      }),
    ).rejects.toThrow("requests_origin_check");

    // Call identity is unique per origin, and NULLs on the other side never collide.
    await insertRequest({
      callId: "shared",
      mode: "durable",
      occurrenceId: occurrence.id,
      runId: null,
    });
    await insertRequest({
      callId: "shared",
      mode: "durable",
      occurrenceId: null,
      runId: fixture.run.id,
    });
    await expect(
      insertRequest({
        callId: "shared",
        mode: "durable",
        occurrenceId: occurrence.id,
        runId: null,
      }),
    ).rejects.toThrow("requests_occurrence_call_identity_unique");
    await expect(
      insertRequest({
        callId: "shared",
        mode: "durable",
        occurrenceId: null,
        runId: fixture.run.id,
      }),
    ).rejects.toThrow("requests_run_call_identity_unique");
  });

  it.for(["existing", "new", "declined"] as const)(
    "persists the Host-derived browser access outcome for %s decisions",
    async (choice, { storeFixture }) => {
      const { startRunFixture, createTaskForOwner, store, database } = storeFixture;
      const fixture = await startRunFixture(`browser-outcome-${choice}`);
      const target = await createTaskForOwner(fixture.userId, `browser_outcome_${choice}`);
      await storeFixture.enrollBrowserRunner(fixture.userId, "Request browser");
      const existing = await store.createBrowserProfile({
        idempotencyKey: `store.integration.test-browser-outcome-${choice}`,
        ownerId: fixture.userId,
        name: "Chosen profile",
      });
      const opened = await store.requests.create({
        callId: `browser-outcome-${choice}`,
        kind: "browser.access",
        mode: "durable",
        originatingRunId: fixture.run.id,
        originatingThreadId: fixture.thread.id,
        requestedBy: fixture.userId,
        requiredActor: "requester",
        payload: {
          kind: "browser.access",
          reason: "Create a work profile",
          suggestion: {
            kind: "new",
            suggestedName: "Suggested work",
          },
        },
        presentation: {
          kind: "external",
          title: "Choose a profile",
          subject: {
            id: target.id,
            kind: "thread",
          },
        },
      });
      const chosenHome =
        choice === "new"
          ? await storeFixture.enrollBrowserRunner(fixture.userId, "Chosen request home")
          : undefined;
      const value =
        choice === "existing"
          ? {
              decision: "fulfilled",
              profileId: existing.id,
            }
          : choice === "new"
            ? {
                decision: "fulfilled",
                createProfile: {
                  name: 'Owner "renamed" work',
                },
              }
            : {
                decision: "declined",
              };
      await expect(
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
          expectedRevision: (await store.requests.revision(opened.request.id))!,
          resolvedBy: fixture.userId,
          response: {
            kind: "external",
            value: {
              ...value,
              profile: {
                id: existing.id,
                name: "Forged",
              },
            },
          },
        }),
      ).rejects.toMatchObject({
        code: "bad_request",
      });
      expect((await store.requests.get(opened.request.id))?.status).toBe("pending");
      const resolved = await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
        expectedRevision: (await store.requests.revision(opened.request.id))!,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value,
        },
      });
      if (chosenHome) expect(resolved.profile?.homeRunnerId).toBe(chosenHome);
      const reread = await new OpensteerStore(database).requests.get(opened.request.id);
      const raw = await database
        .selectFrom("requests")
        .select("response")
        .where("id", "=", opened.request.id)
        .executeTakeFirstOrThrow();
      await writeBrowserUsageArtifact(`browser-request-outcome-${choice}.json`, {
        resolved,
        reread,
        raw,
      });
      const expectedResponse = {
        kind: "external",
        value: {
          ...value,
          ...(choice === "declined"
            ? {}
            : {
                profile: {
                  id: choice === "existing" ? existing.id : resolved.profile?.id,
                  name: choice === "existing" ? existing.name : 'Owner "renamed" work',
                },
              }),
        },
      };
      expect(resolved.request.response).toEqual(expectedResponse);
      expect(reread?.response).toEqual(expectedResponse);
      expect(RequestViewSchema.parse(reread).response).toEqual(expectedResponse);
      expect(raw.response).toEqual(expectedResponse);
      expect(reread?.status).toBe(choice === "declined" ? "declined" : "fulfilled");
      if (choice === "declined") {
        expect(resolved.profile).toBeNull();
      } else {
        expect(resolved.profile).toMatchObject({
          id: expect.any(String),
          name: choice === "existing" ? existing.name : 'Owner "renamed" work',
        });
      }
    },
  );

  it.for(["closed", "failed"] as const)(
    "keeps a %s Browser Session immutable through late transitions",
    async (terminal, { storeFixture }) => {
      const { startRunFixture, store, database } = storeFixture;
      const fixture = await startRunFixture(`browser-terminal-${terminal}`);
      const sessionId = createBrowserSessionId();
      await store.createBrowserSession({
        ownerId: fixture.userId,
        id: sessionId,
        origin: "agent",
        placementKey: `runner:${fixture.runnerId}:browser-terminal-${terminal}`,
        profileId: null,
        runnerId: fixture.runnerId,
        runtimeId: `browser-terminal-${terminal}`,
      });
      await store.transitionBrowserSession({
        sessionId,
        state: terminal,
      });
      const before = await database
        .selectFrom("browserSessions")
        .selectAll()
        .where("id", "=", sessionId)
        .executeTakeFirstOrThrow();
      const writes = [];
      for (const from of [undefined, [terminal]] as const) {
        for (const state of ["starting", "ready", "closing", "closed", "failed"] as const) {
          const result = await store.transitionBrowserSession({
            ...(from
              ? {
                  from,
                }
              : {}),
            sessionId,
            state,
          });
          writes.push({
            from,
            requested: state,
            persisted: result.session.state,
          });
          const after = await database
            .selectFrom("browserSessions")
            .selectAll()
            .where("id", "=", sessionId)
            .executeTakeFirstOrThrow();
          await writeBrowserUsageArtifact(`browser-terminal-${terminal}.json`, {
            before,
            after,
            writes,
          });
          expect(result.session.state).toBe(terminal);

          expect(after).toEqual(before);
        }
      }
    },
  );

  it("refuses an unclaimed Command with no work location", async ({ storeFixture }) => {
    const { createRunFixture, database } = storeFixture;
    const fixture = await createRunFixture("unbound-command");
    const principalId = await sql<{
      readonly id: string;
    }>`select id from principals where user_id = ${fixture.userId}`
      .execute(database)
      .then((result) => result.rows[0]?.id);
    expect(principalId).toBeDefined();
    await expect(
      sql`
        insert into commands (
          id, environment_id, thread_id, requested_by, actor_principal_id,
          authority_source, idempotency_key, type, payload, status
        ) values (
          ${createId("command")}, null, ${fixture.thread.id}, ${fixture.userId}, ${principalId},
          ${JSON.stringify({
            kind: "user-session",
            userId: fixture.userId,
          })}::jsonb,
          ${createId("command")}, 'run.interrupt',
          ${JSON.stringify({
            runId: createId("run"),
            threadId: fixture.thread.id,
            type: "run.interrupt",
          })}::jsonb,
          'pending'
        )
      `.execute(database),
    ).rejects.toThrow("command requester cannot execute the thread environment");
  });

  it("keeps one harness catalog per environment and AI engine, newest answer wins", async ({
    storeFixture,
  }) => {
    const { store, createRunFixture } = storeFixture;
    const { runnerId } = await createRunFixture("harness-catalogs");
    const environmentId = await store.createEnvironment({
      kind: "local",
      name: "Catalog fixture",
      runnerId,
    });
    const laptopEnvironmentId = await store.createEnvironment({
      kind: "local",
      name: "Laptop",
    });
    const native = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const codex = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("codex"),
      environmentId,
      name: "Codex",
      stateKind: "isolated",
    });
    const laptopNative = await store.createHarnessInstance({
      config: {
        model: "test",
      },
      driverKind: HarnessIdSchema.parse("native"),
      environmentId: laptopEnvironmentId,
      name: "Native",
      stateKind: "isolated",
    });
    const readyNative = HarnessInstanceCatalogSchema.parse({
      continuationIdentity: testContinuationIdentity,
      driverKind: "native",
      harnessInstanceId: native.id,
      models: [
        {
          displayName: "GPT-5.6 Sol",
          isDefault: true,
          modelId: "gpt-5.6-sol",
          options: [],
          providerId: "openai",
        },
      ],
      status: "ready",
    });
    const unavailableCodex = HarnessInstanceCatalogSchema.parse({
      detail: "Codex is not installed on this work location",
      driverKind: "codex",
      harnessInstanceId: codex.id,
      models: [],
      status: "unavailable",
    });
    await store.recordHarnessCatalogs({
      catalogs: [readyNative, unavailableCodex],
      environmentId,
      expectedRevisions: new Map([
        [native.id, native.runtimeRevision],
        [codex.id, codex.runtimeRevision],
      ]),
    });
    await store.recordHarnessCatalogs({
      catalogs: [
        {
          ...readyNative,
          harnessInstanceId: laptopNative.id,
        },
      ],
      environmentId: laptopEnvironmentId,
      expectedRevisions: new Map([[laptopNative.id, laptopNative.runtimeRevision]]),
    });
    expect(await store.getHarnessCatalog(environmentId, native.id)).toMatchObject({
      models: [
        {
          modelId: "gpt-5.6-sol",
        },
      ],
      status: "ready",
    });
    expect(await store.getHarnessCatalog(laptopEnvironmentId, codex.id)).toBeNull();
    expect(await store.listHarnessCatalogs([])).toEqual([]);
    const both = await store.listHarnessCatalogs([environmentId, laptopEnvironmentId]);
    expect(both).toHaveLength(3);
    const captured = both.find(
      (record) => record.environmentId === environmentId && record.harnessInstanceId === native.id,
    );
    expect(captured?.capturedAt).toBeInstanceOf(Date);
    await store.recordHarnessCatalogs({
      catalogs: [
        HarnessInstanceCatalogSchema.parse({
          detail: "Sign in to continue",
          driverKind: "native",
          harnessInstanceId: native.id,
          models: [],
          setupMethods: [
            {
              connectionSlot: "primary",
              kind: "device-code",
              label: "Subscription",
              methodId: "subscription",
            },
          ],
          status: "authentication-required",
        }),
      ],
      environmentId,
      expectedRevisions: new Map([[native.id, native.runtimeRevision]]),
    });
    expect(await store.getHarnessCatalog(environmentId, native.id)).toMatchObject({
      setupMethods: [
        expect.objectContaining({
          methodId: "subscription",
        }),
      ],
      status: "authentication-required",
    });
    expect(await store.listHarnessCatalogs([environmentId])).toHaveLength(2);
    const recaptured = (await store.listHarnessCatalogs([environmentId])).find(
      (record) => record.harnessInstanceId === native.id,
    );
    expect(recaptured?.capturedAt.getTime()).toBeGreaterThanOrEqual(
      captured?.capturedAt.getTime() ?? 0,
    );
  });
  it("keeps one execution-preference record per person, newest choice first", async ({
    storeFixture,
  }) => {
    const { store, createRunFixture } = storeFixture;
    const { userId } = await createRunFixture("execution-preferences");
    const environmentId = createId("environment");
    const harnessInstanceId = createId("harnessInstance");
    const lowEffort = ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: {
        effort: "low",
      },
      providerId: "openai",
    });
    const highEffort = ModelSelectionSchema.parse({
      modelId: "gpt-5.6-sol",
      options: {
        effort: "high",
      },
      providerId: "openai",
    });
    const otherModel = ModelSelectionSchema.parse({
      modelId: "claude-opus-5",
      options: {},
      providerId: "anthropic",
    });

    // A person who has never chosen reads the empty record, not nothing.
    await expect(store.getExecutionPreferences(userId)).resolves.toEqual(emptyExecutionPreferences);
    await store.rememberExecutionChoice(userId, {
      selection: {
        environmentId,
        harnessInstanceId,
        modelSelection: lowEffort,
      },
    });
    const second = await store.rememberExecutionChoice(userId, {
      selection: {
        environmentId,
        harnessInstanceId,
        modelSelection: otherModel,
      },
    });
    expect(second.history).toEqual([
      {
        environmentId,
        harnessInstanceId,
        modelSelection: otherModel,
      },
      {
        environmentId,
        harnessInstanceId,
        modelSelection: lowEffort,
      },
    ]);
    expect(second.accessMode).toBe(emptyExecutionPreferences.accessMode);

    // The same choice with newer options replaces its earlier entry rather
    // than accumulating a second one.
    const reopened = await store.rememberExecutionChoice(userId, {
      selection: {
        environmentId,
        harnessInstanceId,
        modelSelection: highEffort,
      },
    });
    expect(reopened.history).toEqual([
      {
        environmentId,
        harnessInstanceId,
        modelSelection: highEffort,
      },
      {
        environmentId,
        harnessInstanceId,
        modelSelection: otherModel,
      },
    ]);

    // An access mode travels on its own and leaves the history alone.
    const supervised = await store.rememberExecutionChoice(userId, {
      accessMode: ThreadAccessModeSchema.parse("approval-required"),
    });
    expect(supervised).toEqual({
      accessMode: "approval-required",
      history: reopened.history,
    });

    // Both halves at once is one write.
    const both = await store.rememberExecutionChoice(userId, {
      accessMode: ThreadAccessModeSchema.parse("auto"),
      selection: {
        environmentId,
        harnessInstanceId,
        modelSelection: otherModel,
      },
    });
    expect(both).toEqual({
      accessMode: "auto",
      history: [
        {
          environmentId,
          harnessInstanceId,
          modelSelection: otherModel,
        },
        {
          environmentId,
          harnessInstanceId,
          modelSelection: highEffort,
        },
      ],
    });
    await expect(store.getExecutionPreferences(userId)).resolves.toEqual(both);
  });
});
