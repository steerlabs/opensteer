import {
  createId,
  emptyExecutionPreferences,
  HarnessIdSchema,
  ModelSelectionSchema,
  RequestViewSchema,
  ThreadAccessModeSchema,
} from "@opensteer/core";
import {
  createIntegrationId,
  IntegrationDefinitionSchema,
  integrationDefinitionSummary,
} from "@opensteer/integration-core";
import { integrationDefinitionDigest } from "@opensteer/integration-core/digest";
import { createBrowserSessionId, HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { expect } from "vitest";

import {
  installIntegrationInTransaction,
  IntegrationPlatformStore,
  OpensteerStore,
} from "./index.js";
import {
  describeStore,
  enrollTestRunner,
  testContinuationIdentity,
  testOpenApiAdapterContract,
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
    expect(consent?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "request.resolved",
          data: expect.objectContaining({
            request: expect.objectContaining({
              response: {
                kind: "external",
                value: {
                  outcome: "authorized",
                  account: "a•••",
                },
              },
              settlementProvenance: {
                sessionId,
                deviceLabel: "Safari on iPhone",
              },
            }),
          }),
        }),
      ]),
    );
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
          kind: "workspace",
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
      () =>
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
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
        events: [
          expect.objectContaining({
            type: "request.resolved",
            runId: null,
          }),
        ],
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
          kind: "workspace",
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
          kind: "workspace",
        },
        title: "Choose browser access",
      },
      requestedBy: fixture.userId,
      requiredActor: "requester" as const,
    };
    const created = await store.requests.create(input);
    const replay = await store.requests.create(input);
    expect(created).toMatchObject({
      // A Trigger Occurrence has no Run to attribute its event to.
      events: [
        expect.objectContaining({
          runId: null,
          type: "request.opened",
        }),
      ],
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
      events: [
        expect.objectContaining({
          runId: null,
          type: "request.resolved",
        }),
      ],
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
      kind: "integration.install" as const,
      mode: "durable" as const,
      originatingThreadId: fixture.thread.id,
      payload: {
        kind: "integration.install" as const,
        manifest: {
          kind: "catalog",
        },
        reason: "The schedule needs it",
      },
      presentation: {
        kind: "choice" as const,
        options: [
          {
            hint: "confirm" as const,
            id: "installed",
            label: "Install",
          },
        ],
        title: "Install?",
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
          kind: values.mode === "live" ? "harness.approval" : "integration.install",
          mode: values.mode,
          originatingOccurrenceId: values.occurrenceId as never,
          originatingRunId: values.runId as never,
          originatingThreadId: fixture.thread.id,
          payload: sql`${JSON.stringify({
            kind: "integration.install",
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
            kind: "workspace",
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
                  ...(chosenHome
                    ? {
                        homeRunnerId: chosenHome,
                      }
                    : {}),
                },
              }
            : {
                decision: "declined",
              };
      await expect(
        store.requests.resolveBrowserRequest({
          requestId: opened.request.id,
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
      if (choice === "new") {
        await expect(
          store.requests.resolveBrowserRequest({
            requestId: opened.request.id,
            resolvedBy: fixture.userId,
            response: {
              kind: "external",
              value: {
                decision: "fulfilled",
                createProfile: {
                  name: "Unplaced",
                },
              },
            },
          }),
        ).rejects.toMatchObject({
          code: "conflict",
        });
      }
      const resolved = await store.requests.resolveBrowserRequest({
        requestId: opened.request.id,
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
          expect(result.events).toEqual([]);
          expect(after).toEqual(before);
        }
      }
    },
  );
  it("binds prepared integration material to the exact approved manifest", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("request-integration-install");

    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "request-installed-calendar",
      provider: "calendar",
    });
    const approvalManifest = {
      definition: integrationDefinitionSummary(contract.definition),
      digest: integrationDefinitionDigest(contract.definition),
      kind: "catalog" as const,
    };
    const opened = await platform.requests.createIntegrationInstallRequest({
      callId: "request-integration-install-call",
      manifest: approvalManifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      reason: "Install the approved calendar integration",
      requestedBy: fixture.userId,
    });
    expect(opened.request.presentation.title).toBe(`Install ${contract.definition.name}?`);
    const installationId = createIntegrationId("installation");
    const material = {
      adapterSnapshot: contract.adapterSnapshot,
      installation: {
        description: contract.definition.description,
        id: installationId,
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: approvalManifest.digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status: "active" as const,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: approvalManifest.digest,
      },
      servers: [
        {
          connectionRequirement: {
            definitionId: contract.definition.id,
            kind: "provider" as const,
            provider: contract.definition.provider,
            providerApplicationRequired: false,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active" as const,
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [],
          },
          transport: {
            adapter: "openapi" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    };
    const differentDefinition = IntegrationDefinitionSchema.parse({
      ...contract.definition,
      name: "Different approved integration",
    });
    const differentApprovalManifest = {
      definition: integrationDefinitionSummary(differentDefinition),
      digest: integrationDefinitionDigest(differentDefinition),
      kind: "catalog" as const,
    };
    await expect(
      platform.requests.resolveIntegrationInstallRequest({
        preparedFulfillment: {
          approvalManifest: differentApprovalManifest,
          material,
        },
        requestId: opened.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "choice",
          optionId: "installed",
        },
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "Prepared installation does not match the approved manifest",
    });
    await expect(platform.requests.get(opened.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(platform.listInstallations()).resolves.toEqual([]);
    await expect(
      platform.install({
        ...material,
        actorUserId: fixture.userId,
        requestId: "revoked-computer-catalog-install",
        settlementSessionId: createId("authSession"),
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(await platform.listInstallations()).toEqual([]);
    const access = await platform.requests.createIntegrationAccessRequest({
      access: "read",
      callId: "revoked-install-access",
      installationId: null,
      manifest: approvalManifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      reason: "Use the reviewed integration",
      requestedBy: fixture.userId,
      requestedServerId: null,
    });
    await expect(
      platform.requests.installForIntegrationAccessRequest({
        preparedFulfillment: {
          approvalManifest,
          material,
        },
        requestId: access.request.id,
        resolvedBy: fixture.userId,
        settlementSessionId: createId("authSession"),
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(await platform.listInstallations()).toEqual([]);
    expect((await platform.requests.get(access.request.id))?.payload).toMatchObject({
      installationId: null,
    });
    const resolved = await platform.requests.resolveIntegrationInstallRequest({
      preparedFulfillment: {
        approvalManifest,
        material,
      },
      requestId: opened.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "choice",
        optionId: "installed",
      },
    });
    await expect(
      platform.requests.tryBindExistingIntegrationAccessInstallation({
        requestId: access.request.id,
        resolvedBy: fixture.userId,
        settlementSessionId: createId("authSession"),
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect((await platform.requests.get(access.request.id))?.payload).toMatchObject({
      installationId: null,
    });
    expect(resolved).toMatchObject({
      events: [
        expect.objectContaining({
          type: "request.resolved",
        }),
      ],
      installation: {
        id: installationId,
        manifest: contract.manifest,
        sourceKind: "built-in",
      },
      request: {
        id: opened.request.id,
        status: "fulfilled",
      },
    });
    await expect(platform.listInstallations()).resolves.toEqual([
      expect.objectContaining({
        id: installationId,
        manifest: contract.manifest,
      }),
    ]);
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("requestContinuations")
        .select("status")
        .where("requestId", "=", opened.request.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "waiting",
    });
  });
  it("enriches valid integration access, rejects mismatched accounts, and preserves project grants", async ({
    storeFixture,
  }) => {
    const {
      startRunFixture,

      database,
    } = storeFixture;
    const fixture = await startRunFixture("integration-access-target-authority");

    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const serverId = createIntegrationId("server");
    const mcpServerId = createIntegrationId("server");
    const toolId = createIntegrationId("tool");
    const inputSchema = {
      properties: {},
      type: "object",
    };
    const installed = await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: {
        description: "Connectionless tools",
        id: installationId,
        manifest: {},
        name: "request-target-authority",
        provenance: {},
        sourceKind: "remote-mcp",
        status: "active",
        title: "Request target authority",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-integration-access-target-authority",
      servers: [
        {
          connectionRequirement: {
            definitionId: "request-target-authority",
            kind: "provider",
            provider: "records",
            providerApplicationRequired: false,
          },
          id: serverId,
          name: "default",
          status: "active",
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [
              {
                annotations: {},
                connectionId: null,
                description: "Read records",
                id: toolId,
                inputSchema,
                name: "records.read",
                outputSchema: null,
                status: "active",
                title: "Read records",
              },
            ],
          },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://request-target-authority.example.test/mcp",
          },
        },
        {
          connectionRequirement: {
            kind: "mcp-oauth",
          },
          id: mcpServerId,
          name: "oauth",
          status: "active",
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [],
          },
          transport: {
            headers: {},
            type: "streamable-http",
            url: "https://request-target-authority.example.test/oauth-mcp",
          },
        },
      ],
    });
    const [server] = await platform.listServers(installationId);
    if (!server) throw new Error("Installed integration server is missing");
    const connectionId = createIntegrationId("connection");
    await database
      .insertInto("integrationConnections")
      .values({
        accountIdentifier: "alex@example.com",
        applicationSource: sql`'{"kind":"api-key"}'::jsonb`,
        authMethodId: "api-key",
        authorizationDigest: "a".repeat(43),
        capabilities: sql`'[]'::jsonb`,
        runnerId: null,
        connectionKind: "provider-account",
        connectionMethod: "api-key",
        credentialId: null,
        displayName: "Alex",
        externalIdentityId: "alex-authoritative",
        externalTenantId: null,
        grantedScopes: sql`'[]'::jsonb`,
        id: connectionId,
        integrationDefinitionId: "request-target-authority",
        integrationServerId: null,
        ownerUserId: fixture.userId,
        provider: "records",
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();
    const mcpConnectionId = createIntegrationId("connection");
    await database
      .insertInto("integrationConnections")
      .values({
        accountIdentifier: null,
        applicationSource: null,
        authMethodId: null,
        authorizationDigest: null,
        capabilities: sql`'[]'::jsonb`,
        runnerId: null,
        connectionKind: "mcp-oauth",
        connectionMethod: "managed-oauth",
        credentialId: null,
        displayName: "Team MCP",
        externalIdentityId: null,
        externalTenantId: null,
        grantedScopes: sql`'[]'::jsonb`,
        id: mcpConnectionId,
        integrationDefinitionId: null,
        integrationServerId: mcpServerId,
        ownerUserId: fixture.userId,
        provider: `mcp:${mcpServerId}`,
        providerApplicationId: null,
        status: "connected",
        statusDetail: null,
        transportKind: null,
        updatedAt: new Date(),
      })
      .executeTakeFirstOrThrow();
    await expect(
      Promise.all([
        platform.getConnectionKind({
          connectionId,
          ownerUserId: fixture.userId,
        }),
        platform.getConnectionKind({
          connectionId: mcpConnectionId,
          ownerUserId: fixture.userId,
        }),
        platform.getConnectionKind({
          connectionId,
          ownerUserId: createId("user"),
        }),
      ]),
    ).resolves.toEqual(["provider-account", "mcp-oauth", null]);
    const requestInput = {
      access: "read" as const,
      installationId,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      reason: "Read records",
      requestedBy: fixture.userId,
      requestedServerId: serverId,
    };
    const mainRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-main-target",
    });
    expect(mainRequest.request.presentation.title).toBe(`${installed.installation.title} access`);
    const mainResolution = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: mainRequest.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          account: {
            accountIdentifier: "forged@example.com",
            displayName: "Forged Alias",
          },
          connectionId,
          decision: "fulfilled",
        },
      },
    });
    expect(mainResolution).toMatchObject({
      events: [
        expect.objectContaining({
          type: "request.resolved",
        }),
      ],
      grant: null,
      request: {
        response: {
          kind: "external",
          value: {
            account: {
              accountIdentifier: "alex@example.com",
              displayName: "Alex",
            },
            connectionId,
            decision: "fulfilled",
          },
        },
        status: "fulfilled",
      },
    });
    await expect(platform.requests.get(mainRequest.request.id)).resolves.toMatchObject({
      response: {
        kind: "external",
        value: {
          account: {
            accountIdentifier: "alex@example.com",
            displayName: "Alex",
          },
          connectionId,
          decision: "fulfilled",
        },
      },
    });
    await expect(
      platform.listGrants({
        ownerUserId: fixture.userId,
      }),
    ).resolves.toEqual([]);
    const projectRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-project-target",
      requestedServerId: null,
    });
    await expect(
      platform.requests.selectIntegrationAccessServer({
        requestId: projectRequest.request.id,
        requestedServerId: serverId,
        resolvedBy: fixture.userId,
        settlementSessionId: createId("authSession"),
      }),
    ).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect((await platform.requests.get(projectRequest.request.id))?.payload).toMatchObject({
      requestedServerId: null,
    });
    await platform.requests.selectIntegrationAccessServer({
      requestId: projectRequest.request.id,
      requestedServerId: serverId,
      resolvedBy: fixture.userId,
    });
    const projectResolution = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: projectRequest.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          account: {
            accountIdentifier: "forged@example.com",
            displayName: "Forged Alias",
          },
          access: "read",
          alias: "Records",
          connectionId,
          decision: "fulfilled",
          isDefault: false,
        },
      },
    });
    expect(projectResolution).toMatchObject({
      events: [
        expect.objectContaining({
          type: "request.resolved",
        }),
      ],
      grant: {},
      request: {
        status: "fulfilled",
      },
    });
    expect(projectResolution.request.response).toEqual({
      kind: "external",
      value: {
        access: "read",
        alias: "Records",
        account: {
          accountIdentifier: "alex@example.com",
          displayName: "Alex",
        },
        connectionId,
        decision: "fulfilled",
        isDefault: false,
      },
    });
    const requiredWrite = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      access: "read-write",
      callId: "integration-access-required-write",
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: requiredWrite.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            access: "read",
            alias: "Records",
            connectionId,
            decision: "fulfilled",
            isDefault: false,
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Integration access does not cover the requested write operations",
    });
    await expect(platform.requests.get(requiredWrite.request.id)).resolves.toMatchObject({
      status: "pending",
    });
    const missingConnectionId = createIntegrationId("connection");
    const missingConnectionRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-missing-account-row",
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: missingConnectionRequest.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            account: {
              accountIdentifier: "forged@example.com",
              displayName: "Forged Alias",
            },
            connectionId: missingConnectionId,
            decision: "fulfilled",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(platform.requests.get(missingConnectionRequest.request.id)).resolves.toMatchObject(
      {
        response: null,
        status: "pending",
      },
    );
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: missingConnectionRequest.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            connectionId: mcpConnectionId,
            decision: "fulfilled",
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "forbidden",
    });
    const declinedRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-declined",
    });
    const declinedResolution = await platform.requests.resolveIntegrationAccessRequest({
      providerAuthorizations: {},
      requestId: declinedRequest.request.id,
      resolvedBy: fixture.userId,
      response: {
        kind: "external",
        value: {
          account: {
            accountIdentifier: "forged@example.com",
            displayName: "Forged Alias",
          },
          decision: "declined",
        },
      },
    });
    expect(declinedResolution.request).toMatchObject({
      id: declinedRequest.request.id,
      status: "declined",
    });
    expect(declinedResolution.request.response).toEqual({
      kind: "external",
      value: {
        decision: "declined",
      },
    });
    const persistedDecline = await platform.requests.get(declinedRequest.request.id);
    expect(persistedDecline?.response).toEqual({
      kind: "external",
      value: {
        decision: "declined",
      },
    });
    const mcpRequest = await platform.requests.createIntegrationAccessRequest({
      ...requestInput,
      callId: "integration-access-mcp-account",
      requestedServerId: mcpServerId,
    });
    await expect(
      platform.requests.resolveIntegrationAccessRequest({
        providerAuthorizations: {},
        requestId: mcpRequest.request.id,
        resolvedBy: fixture.userId,
        response: {
          kind: "external",
          value: {
            connectionId: mcpConnectionId,
            decision: "fulfilled",
          },
        },
      }),
    ).resolves.toMatchObject({
      request: {
        status: "fulfilled",
      },
    });
    await expect(
      platform.listGrants({
        ownerUserId: fixture.userId,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        access: "read",
      }),
    ]);
    await expect(platform.requests.listPendingContinuations()).resolves.toEqual([]);
    const storedContinuations = await database
      .selectFrom("requestContinuations")
      .select(["requestId", "status"])
      .orderBy("requestId", "asc")
      .execute();
    expect(storedContinuations).toEqual(
      [
        mainRequest.request.id,
        projectRequest.request.id,
        declinedRequest.request.id,
        mcpRequest.request.id,
      ]
        .sort()
        .map((requestId) => ({
          requestId,
          status: "waiting",
        })),
    );
  });
  it("serializes catalog Request currentness by exact definition identity and preserves replay", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("catalog-request-currentness");
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "catalog-request-currentness",
      provider: "calendar",
    });
    const manifest = {
      definition: integrationDefinitionSummary(contract.definition),
      digest: integrationDefinitionDigest(contract.definition),
      kind: "catalog" as const,
    };
    const requestInput = {
      manifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      reason: "Install the current catalog definition",
      requestedBy: fixture.userId,
    };

    // Neither a matching installation name nor public manifest is catalog
    // identity. Only exact built-in provenance.definitionId closes selection.
    await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: {
        description: "Legacy built-in without catalog provenance",
        id: createIntegrationId("installation"),
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          maintainedBy: "test",
        },
        sourceKind: "built-in",
        status: "active",
        title: "Legacy built-in",
        trust: "built-in",
        version: "legacy",
      },
      requestId: "install-catalog-currentness-decoy",
      servers: [],
    });
    const original = await platform.requests.createIntegrationInstallRequest({
      ...requestInput,
      callId: "catalog-currentness-original",
    });
    expect(original).toMatchObject({
      replayed: false,
      request: {
        status: "pending",
      },
    });
    const material = {
      adapterSnapshot: contract.adapterSnapshot,
      installation: {
        description: contract.definition.description,
        id: createIntegrationId("installation"),
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: manifest.digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status: "active" as const,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: manifest.digest,
      },
      servers: [
        {
          connectionRequirement: {
            definitionId: contract.definition.id,
            kind: "provider" as const,
            provider: contract.definition.provider,
            providerApplicationRequired: false,
          },
          id: createIntegrationId("server"),
          name: "default",
          status: "active" as const,
          statusDetail: null,
          catalog: {
            definitions: {},
            tools: [],
          },
          transport: {
            adapter: "openapi" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    };
    let releaseInstallation: () => void = () => {};
    const releaseSignal = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    let announceInstallation: () => void = () => {};
    const installationWritten = new Promise<void>((resolve) => {
      announceInstallation = resolve;
    });
    const installing = database.transaction().execute(async (transaction) => {
      const mutation = await installIntegrationInTransaction(transaction, {
        ...material,
        actorUserId: fixture.userId,
        requestId: "install-exact-catalog-currentness",
      });
      announceInstallation();
      await releaseSignal;
      return mutation;
    });
    await installationWritten;
    const raced = platform.requests.createIntegrationInstallRequest({
      ...requestInput,
      callId: "catalog-currentness-raced",
    });
    void raced.catch(() => undefined);
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting === 0; attempt += 1) {
        const result = await sql<{
          readonly waiting: number;
        }>`
          select count(*)::integer as waiting
          from pg_locks locks
          join pg_stat_activity activity on activity.pid = locks.pid
          where locks.granted = false
            and locks.locktype = 'advisory'
            and activity.datname = current_database()
            and activity.application_name = 'opensteer-integration-test'
        `.execute(database);
        waiting = Number(result.rows[0]?.waiting ?? 0);
        if (waiting === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBeGreaterThan(0);
    } finally {
      releaseInstallation();
    }
    await installing;
    await expect(raced).rejects.toMatchObject({
      code: "conflict",
      message:
        "Catalog integration is already installed; search current integration inventory before requesting setup",
    });
    await expect(
      platform.requests.createIntegrationInstallRequest({
        ...requestInput,
        callId: "catalog-currentness-original",
      }),
    ).resolves.toMatchObject({
      replayed: true,
      request: {
        id: original.request.id,
        status: "pending",
      },
    });
  });

  /**
   * A built-in that materialized badly used to be unreachable: the catalog gate
   * treated any installation row as "already installed", so the one action that
   * could repair it — reinstalling from the current definition — was refused.
   */
  it("keeps a needs-attention built-in requestable and refuses only an active one", async ({
    storeFixture,
  }) => {
    const { startRunFixture, database } = storeFixture;
    const fixture = await startRunFixture("catalog-needs-attention-reinstall");
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "catalog-needs-attention-reinstall",
      provider: "calendar",
    });
    const manifest = {
      definition: integrationDefinitionSummary(contract.definition),
      digest: integrationDefinitionDigest(contract.definition),
      kind: "catalog" as const,
    };
    const requestInput = {
      manifest,
      originatingRunId: fixture.run.id,
      originatingThreadId: fixture.thread.id,
      reason: "Reinstall the integration that failed discovery",
      requestedBy: fixture.userId,
    };
    const installationId = createIntegrationId("installation");
    const installedMaterial = (status: "active" | "needs-attention") => ({
      actorUserId: fixture.userId,
      adapterSnapshot: contract.adapterSnapshot,
      installation: {
        description: contract.definition.description,
        id: installationId,
        manifest: contract.manifest,
        name: contract.definition.id,
        provenance: {
          definitionDigest: manifest.digest,
          definitionId: contract.definition.id,
          maintainedBy: "opensteer",
        },
        sourceKind: "built-in" as const,
        status,
        title: contract.definition.name,
        trust: "built-in" as const,
        version: manifest.digest,
      },
      servers: [
        {
          connectionRequirement: {
            kind: "none" as const,
          },
          id: createIntegrationId("server"),
          name: "default",
          status,
          statusDetail: status === "active" ? null : "Discovery fetch failed: HTTP 502",
          catalog: {
            definitions: {},
            tools: [],
          },
          transport: {
            adapter: "openapi" as const,
            definitionId: contract.definition.id,
            type: "adapter" as const,
          },
        },
      ],
    });
    await platform.install({
      ...installedMaterial("needs-attention"),
      requestId: "install-needs-attention-builtin",
    });
    const reinstall = await platform.requests.createIntegrationInstallRequest({
      ...requestInput,
      callId: "catalog-needs-attention-reinstall-call",
    });
    expect(reinstall).toMatchObject({
      replayed: false,
      request: {
        status: "pending",
      },
    });
    expect(reinstall.request.presentation.title).toBe(`Install ${contract.definition.name}?`);
    await platform.install({
      ...installedMaterial("active"),
      requestId: "install-active-builtin",
    });
    await expect(
      platform.requests.createIntegrationInstallRequest({
        ...requestInput,
        callId: "catalog-active-reinstall-call",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message:
        "Catalog integration is already installed; search current integration inventory before requesting setup",
    });
  });

  /**
   * A Trigger fires again on its own schedule and each Occurrence carries a
   * fresh call identity, so an unanswered ask would otherwise leave one approval
   * card per tick. A Run keeps its own Request: its continuation is delivered to
   * the Run that opened it.
   */
  it("folds a Trigger Occurrence's repeated installation ask into the pending Request", async ({
    storeFixture,
  }) => {
    const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
    const fixture = await startRunFixture("trigger-install-dedup");
    const occurrence = await startTriggerOccurrence(fixture, "trigger-install-dedup");
    const platform = new IntegrationPlatformStore(database);
    const contract = testOpenApiAdapterContract({
      definitionId: "trigger-install-dedup",
      provider: "calendar",
    });
    const base = {
      manifest: {
        definition: integrationDefinitionSummary(contract.definition),
        digest: integrationDefinitionDigest(contract.definition),
        kind: "catalog" as const,
      },
      originatingThreadId: fixture.thread.id,
      reason: "The schedule needs the calendar",
      requestedBy: fixture.userId,
    };
    const proposal = {
      kind: "proposal" as const,
      proposal: {
        authMethods: ["api-key" as const],
        digest: "p".repeat(43),
        kind: "openapi" as const,
        preview: {
          operationCount: 3,
          title: "Researched API",
        },
        source: {
          content: '{"openapi":"3.1.0"}',
          type: "inline" as const,
        },
      },
    };
    const first = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-1",
      originatingOccurrenceId: occurrence.id,
    });
    const repeated = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-2",
      originatingOccurrenceId: occurrence.id,
    });
    expect(first).toMatchObject({
      replayed: false,
      request: {
        status: "pending",
      },
    });
    expect(repeated).toMatchObject({
      events: [],
      replayed: true,
      request: {
        id: first.request.id,
      },
    });
    const proposed = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-3",
      manifest: proposal,
      originatingOccurrenceId: occurrence.id,
    });
    const proposedAgain = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "occurrence-install-call-4",
      manifest: proposal,
      originatingOccurrenceId: occurrence.id,
    });

    // A different artifact is a different ask, and an agent-supplied title is
    // marked as proposed by an agent so it cannot read as Opensteer's own prose.
    expect(proposed.replayed).toBe(false);
    expect(proposed.request.presentation).toMatchObject({
      agentProposed: true,
      title: "Install Researched API?",
    });
    expect(proposedAgain).toMatchObject({
      replayed: true,
      request: {
        id: proposed.request.id,
      },
    });
    const runOriginated = await platform.requests.createIntegrationInstallRequest({
      ...base,
      callId: "run-install-call-1",
      originatingRunId: fixture.run.id,
    });
    expect(runOriginated.replayed).toBe(false);
    expect(runOriginated.request.id).not.toBe(first.request.id);
  });
  it("deduplicates integration access only for the same installation, class, and server", async ({
    storeFixture,
  }) => {
    const { startRunFixture, startTriggerOccurrence, database } = storeFixture;
    const fixture = await startRunFixture("trigger-access-dedup");
    const occurrence = await startTriggerOccurrence(fixture, "trigger-access-dedup");
    const platform = new IntegrationPlatformStore(database);
    const installationId = createIntegrationId("installation");
    const inputSchema = {
      properties: {},
      type: "object",
    };
    const serverMaterial = (name: string) => {
      const serverId = createIntegrationId("server");
      const toolId = createIntegrationId("tool");
      return {
        connectionRequirement: {
          kind: "none" as const,
        },
        id: serverId,
        name,
        status: "active" as const,
        statusDetail: null,
        catalog: {
          definitions: {},
          tools: [
            {
              annotations: {},
              connectionId: null,
              description: "Read records",
              id: toolId,
              inputSchema,
              name: `${name}.read`,
              outputSchema: null,
              status: "active" as const,
              title: "Read records",
            },
          ],
        },
        transport: {
          headers: {},
          type: "streamable-http" as const,
          url: `https://trigger-access-dedup.example.test/${name}`,
        },
      };
    };
    const primary = serverMaterial("primary");
    const secondary = serverMaterial("secondary");
    await platform.install({
      actorUserId: fixture.userId,
      adapterSnapshot: null,
      installation: {
        description: "Researched by an agent",
        id: installationId,
        manifest: {},
        name: "trigger-access-dedup",
        provenance: {
          artifactDigest: "q".repeat(43),
          proposalKind: "openapi",
        },
        sourceKind: "proposed",
        status: "active",
        title: "Records — approved by your administrator",
        trust: "administrator-approved",
        version: "1",
      },
      requestId: "install-trigger-access-dedup",
      servers: [primary, secondary],
    });
    const servers = await platform.listServers(installationId);
    const primaryServer = servers.find(({ name }) => name === "primary");
    const secondaryServer = servers.find(({ name }) => name === "secondary");
    if (!primaryServer || !secondaryServer) throw new Error("Both servers must be installed");
    const base = {
      access: "read" as const,
      installationId,
      originatingOccurrenceId: occurrence.id,
      originatingThreadId: fixture.thread.id,
      reason: "The schedule needs the records",
      requestedBy: fixture.userId,
    };
    const first = await platform.requests.createIntegrationAccessRequest({
      ...base,
      callId: "occurrence-access-call-1",
      requestedServerId: primaryServer.id,
    });
    const repeated = await platform.requests.createIntegrationAccessRequest({
      ...base,
      callId: "occurrence-access-call-2",
      requestedServerId: primaryServer.id,
    });
    const other = await platform.requests.createIntegrationAccessRequest({
      ...base,
      callId: "occurrence-access-call-3",
      requestedServerId: secondaryServer.id,
    });

    // A proposed installation's title is text an agent supplied, so every
    // surface marks it rather than letting it read as the platform's own words.
    expect(first.request.presentation).toMatchObject({
      agentProposed: true,
      title: "Records — approved by your administrator access",
    });
    expect(repeated).toMatchObject({
      events: [],
      replayed: true,
      request: {
        id: first.request.id,
      },
    });
    expect(other).toMatchObject({
      events: [
        expect.objectContaining({
          type: "request.opened",
        }),
      ],
      replayed: false,
      request: {
        payload: {
          requestedServerId: secondaryServer.id,
        },
      },
    });
  });
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

  it("leaves Main and local work locations untouched by the ownership binding", async ({
    storeFixture,
  }) => {
    const { store, sqlCanExecute } = storeFixture;
    const ownerId = await store.createUser("Owner");
    const otherId = await store.createUser("Other");
    const mainEnvironmentId = createId("environment");
    const laptopEnvironmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: mainEnvironmentId,
      name: "Main runner",
      runnerId: createId("runner"),
      tokenSuffix: "binding-regression-main",
    });
    await enrollTestRunner(store, {
      createdBy: ownerId,
      environmentId: laptopEnvironmentId,
      name: "Owner's laptop",
      runnerId: createId("runner"),
      runnerKind: "local",
      tokenSuffix: "binding-regression-laptop",
    });
    for (const userId of [ownerId, otherId]) {
      await expect(store.environmentIsAvailableToUser(mainEnvironmentId, userId)).resolves.toBe(
        true,
      );
      await expect(sqlCanExecute(mainEnvironmentId, userId)).resolves.toBe(true);
    }
    await expect(store.environmentIsAvailableToUser(laptopEnvironmentId, ownerId)).resolves.toBe(
      true,
    );
    await expect(store.environmentIsAvailableToUser(laptopEnvironmentId, otherId)).resolves.toBe(
      false,
    );
    await expect(sqlCanExecute(laptopEnvironmentId, ownerId)).resolves.toBe(true);
    await expect(sqlCanExecute(laptopEnvironmentId, otherId)).resolves.toBe(false);
    expect((await store.listEnvironmentsForUser(otherId)).map((item) => item.id)).toEqual([
      mainEnvironmentId,
    ]);
  });

  it("keeps one harness catalog per environment and AI engine, newest answer wins", async ({
    storeFixture,
  }) => {
    const { store } = storeFixture;
    const userId = await store.createUser("Alex");
    const environmentId = createId("environment");
    await enrollTestRunner(store, {
      createdBy: userId,
      environmentId,
      name: "Managed Runner",
      runnerId: createId("runner"),
      tokenSuffix: "harness-catalogs",
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
    const { store } = storeFixture;
    const userId = await store.createUser("Alex");
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
