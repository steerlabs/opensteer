import { ThreadAccessModeSchema, createId, type Message } from "@opensteer/core";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AgentBrowserSessionSummarySchema,
  AgentControlRequestSchema,
  AgentControlResponseSchema,
  BrowserAttachTicketClaimsSchema,
  BrowserAttachTicketIdentitySchema,
  BrowserClientMessageSchema,
  BrowserServerMessageSchema,
  DesktopAccountAuthStateSchema,
  HarnessInstanceCatalogSchema,
  HarnessInstanceCatalogViewSchema,
  HostToRunnerMessageSchema,
  HostedBrowserSessionSchema,
  PendingAgentEventSchema,
  PersonalRemoteAccessStatusSchema,
  PublishPersonalConnectProjectionRequestSchema,
  RunnerCommandSchema,
  RunnerDescriptorSchema,
  RunnerHarnessDriverSchema,
  RunnerHarnessDriverViewSchema,
  RunnerToHostMessageSchema,
  StartHostedBrowserBodySchema,
  advertisedRunnerModules,
  agentToolPayloadMaxSerializedBytes,
  decodeBrowserFrameEnvelope,
  maxHarnessInstancesPerEnvironment,
  maxHarnessModelsPerCatalog,
  runnerEnvironmentIds,
} from "./index.js";

/** The fence every post-authentication frame repeats in both directions. */
const wireFence = {
  bootId: `rbt_00000000-0000-4000-8000-000000000001`,
  connectionGeneration: 1,
  connectionId: `rcn_00000000-0000-4000-8000-000000000001`,
  connectionLeaseId: `rls_00000000-0000-4000-8000-000000000001`,
  runnerId: createId("runner"),
} as const;

describe("wire protocol", () => {
  it("exposes safe Host-owned Personal link metadata without accepting credential couriers", () => {
    const status = {
      accountLink: {
        generation: "g".repeat(43),
        issuer: "https://accounts.opensteer.test",
        state: "active",
        subject: `acct_${randomUUID()}`,
      },
      generation: 1,
      mode: "off",
      route: null,
      schemaVersion: 2,
    } as const;
    expect(PersonalRemoteAccessStatusSchema.parse(status)).toEqual(status);
    expect(
      PersonalRemoteAccessStatusSchema.safeParse({
        accountLinked: true,
        generation: 1,
        mode: "off",
        route: null,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      PublishPersonalConnectProjectionRequestSchema.safeParse({
        controlApiOrigin: "https://accounts.opensteer.test",
        expectedAccessRoute: null,
        hostCredential: `osc_${"h".repeat(43)}`,
        schemaVersion: 2,
        state: "disabled",
      }).success,
    ).toBe(false);
  });

  it("publishes Desktop Account lifecycle and identity as one atomic snapshot", () => {
    const signedIn = {
      account: {
        available: true,
        detail: null,
        identity: {
          email: "alex@work.example",
          issuer: "https://accounts.opensteer.com",
          subject: `acct_${randomUUID()}`,
        },
        status: "signed-in",
      },
      schemaVersion: 2,
    } as const;

    expect(DesktopAccountAuthStateSchema.parse(signedIn)).toEqual(signedIn);
    expect(
      DesktopAccountAuthStateSchema.safeParse({
        account: { available: true, detail: null, status: "signed-in" },
        schemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("keeps provider state and setup methods explicit", () => {
    const catalog = {
      connections: [],
      detail: "Sign in to Codex",
      driverKind: "codex",
      harnessInstanceId: createId("harnessInstance"),
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
    } as const;
    expect(HarnessInstanceCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(
      HarnessInstanceCatalogSchema.safeParse({
        ...catalog,
        status: "setup-required",
      }).success,
    ).toBe(false);

    const message = {
      ...wireFence,
      request: {
        action: "start",
        harness: {
          config: {},
          driverKind: "codex",
          id: catalog.harnessInstanceId,
          name: "Codex",
          runtimeRevision: 1,
          sourceId: "openai",
          stateKind: "isolated",
        },
        methodId: "codex-subscription",
      },
      requestId: "authentication-test",
      type: "host.harness-authentication",
    } as const;
    expect(HostToRunnerMessageSchema.parse(message)).toEqual(message);
    expect(
      HostToRunnerMessageSchema.safeParse({
        ...message,
        request: { ...message.request, method: "chatgpt-device-code" },
      }).success,
    ).toBe(false);
  });

  it("carries complete large model catalogs and bounds pathological counts", () => {
    const model = (index: number) => ({
      displayName: `Model ${index}`,
      isDefault: index === 0,
      modelId: `model-${index}`,
      nativeModelId: `model-${index}`,
      options: [],
      providerId: "test",
    });
    const catalog = {
      continuationIdentity: {
        continuationKey: `runner:v1:${"a".repeat(43)}`,
        driverKind: "opencode",
      },
      driverKind: "opencode",
      harnessInstanceId: createId("harnessInstance"),
      models: Array.from({ length: 300 }, (_, index) => model(index)),
      status: "ready",
    } as const;
    expect(HarnessInstanceCatalogSchema.parse(catalog).models).toHaveLength(300);
    expect(
      HarnessInstanceCatalogSchema.safeParse({
        ...catalog,
        models: Array.from({ length: maxHarnessModelsPerCatalog + 1 }, (_, index) => model(index)),
      }).success,
    ).toBe(false);

    const capturedAt = "2026-09-17T12:00:00.000Z";
    expect(HarnessInstanceCatalogViewSchema.parse({ ...catalog, capturedAt }).capturedAt).toBe(
      capturedAt,
    );
    expect(HarnessInstanceCatalogSchema.safeParse({ ...catalog, capturedAt }).success).toBe(false);
  });

  it("separates a full-set harness reconciliation from a read-only inspection", () => {
    const harnesses = [
      {
        config: {},
        driverKind: "codex",
        id: createId("harnessInstance"),
        name: "Codex",
        runtimeRevision: 1,
        sourceId: "openai",
        stateKind: "isolated",
      },
    ] as const;
    for (const type of ["host.reconcile-harnesses", "host.inspect-harnesses"] as const) {
      const message = { ...wireFence, harnesses, requestId: "catalog-test", type } as const;
      expect(HostToRunnerMessageSchema.parse(message)).toEqual(message);
      // Authority is carried by the message type, never by a flag on it: a
      // partial list could otherwise be sent as a complete desired set.
      expect(HostToRunnerMessageSchema.safeParse({ ...message, authoritative: true }).success).toBe(
        false,
      );
    }

    const tooManyHarnesses = Array.from(
      { length: maxHarnessInstancesPerEnvironment + 1 },
      (_, index) => ({
        ...harnesses[0],
        id: createId("harnessInstance"),
        name: `Codex ${index}`,
      }),
    );
    expect(
      HostToRunnerMessageSchema.safeParse({
        ...wireFence,
        harnesses: tooManyHarnesses,
        requestId: "oversized-reconcile",
        type: "host.reconcile-harnesses",
      }).success,
    ).toBe(false);
    expect(
      RunnerToHostMessageSchema.safeParse({
        catalogs: tooManyHarnesses.map((harness) => ({
          connections: [],
          detail: "Unavailable",
          driverKind: harness.driverKind,
          harnessInstanceId: harness.id,
          models: [],
          setupMethods: [],
          status: "unavailable",
        })),
        requestId: "oversized-catalog",
        type: "runner.harness-catalog",
      }).success,
    ).toBe(false);
  });

  it("carries the access modes an engine can enforce, and refuses a driver that names none", () => {
    const driver = {
      accessModes: ["approval-required", "full-access"],
      driverKind: "codex",
      readiness: "configured",
      sources: harnessSources("openai", "OpenAI"),
    } as const;

    expect(RunnerHarnessDriverSchema.parse(driver)).toEqual(driver);
    // A view of the same advertisement tolerates keys it has not heard of, so a
    // newer Host can add one without stopping an older client.
    expect(
      RunnerHarnessDriverViewSchema.parse({ ...driver, futureField: "ignored" }),
    ).toMatchObject({ accessModes: ["approval-required", "full-access"] });
    // A runnable engine that enforces nothing could run no Thread at all.
    expect(RunnerHarnessDriverSchema.safeParse({ ...driver, accessModes: [] }).success).toBe(false);
    expect(
      RunnerHarnessDriverSchema.safeParse({ ...driver, accessModes: ["unsupervised"] }).success,
    ).toBe(false);
    // An unavailable driver enforces nothing because it runs nothing.
    expect(
      RunnerHarnessDriverSchema.safeParse({
        driverKind: "codex",
        readiness: "unavailable",
        reason: "Not installed",
      }).success,
    ).toBe(true);
  });

  it("advertises exactly one environment per agents Runner", () => {
    const agents = {
      environmentIds: [createId("environment")],
      harnessDrivers: [
        {
          accessModes: [...ThreadAccessModeSchema.options],
          driverKind: "codex",
          readiness: "configured",
          sources: harnessSources("openai", "OpenAI"),
        },
      ],
      localStorage: {
        bindings: [],
        storageAuthorityId: createId("storageAuthority"),
        truncated: false,
      },
      maxConcurrentRuns: 2,
      providerStateModes: ["isolated"],
      workspaceBackings: ["local-directory"],
      workspaceMounts: [],
    } as const;
    const descriptor = {
      bootId: `rbt_${randomUUID()}`,
      capabilities: ["filesystem"],
      modules: { agents },
      name: "Runner",
      runnerId: createId("runner"),
      runnerKind: "local",
      runtimeVersion: "test",
    } as const;
    expect(RunnerDescriptorSchema.parse(descriptor)).toMatchObject({
      modules: { agents: { environmentIds: agents.environmentIds } },
    });
    // A Runner holds one unscoped harness registry, so a second environment is
    // a shape the reconciler could never honor.
    for (const environmentIds of [[], [createId("environment"), createId("environment")]]) {
      expect(
        RunnerDescriptorSchema.safeParse({
          ...descriptor,
          modules: { agents: { ...agents, environmentIds } },
        }).success,
      ).toBe(false);
    }
  });

  it("refuses a Runner that advertises no module at all", () => {
    expect(
      RunnerDescriptorSchema.safeParse({
        bootId: `rbt_${randomUUID()}`,
        capabilities: [],
        modules: {},
        name: "Nothing",
        runnerId: createId("runner"),
        runnerKind: "managed",
        runtimeVersion: "test",
      }).success,
    ).toBe(false);
  });

  it("lets a browser-only Runner exist without a work location", () => {
    const descriptor = RunnerDescriptorSchema.parse({
      bootId: `rbt_${randomUUID()}`,
      capabilities: [],
      modules: { browser: { wireVersion: 2, runtimeId: "chromium" } },
      name: "Hosted browser",
      runnerId: createId("runner"),
      runnerKind: "managed",
      runtimeVersion: "test",
    });
    expect(runnerEnvironmentIds(descriptor)).toEqual([]);
    expect(advertisedRunnerModules(descriptor.modules)).toEqual(["browser"]);
    for (const browser of [
      { runtimeId: "chromium" },
      { wireVersion: 1, runtimeId: "chromium" },
      { wireVersion: 3, runtimeId: "chromium" },
    ]) {
      expect(
        RunnerDescriptorSchema.parse({ ...descriptor, modules: { browser } }).modules.browser,
      ).toEqual(browser);
    }
    for (const wireVersion of [0, -1, 1.5]) {
      expect(
        RunnerDescriptorSchema.safeParse({
          ...descriptor,
          modules: { browser: { wireVersion, runtimeId: "chromium" } },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown fields at trust boundaries", () => {
    expect(() =>
      RunnerToHostMessageSchema.parse({
        type: "runner.heartbeat",
        activeRunIds: [],
        sentAt: new Date().toISOString(),
        surprise: true,
      }),
    ).toThrow();
  });

  it("keeps viewer subscriptions separate from bounded session viewport commands", () => {
    expect(
      BrowserClientMessageSchema.safeParse({
        type: "stream.subscribe",
      }).success,
    ).toBe(true);
    expect(
      BrowserClientMessageSchema.parse({
        height: 900,
        surfaceId: "page-1",
        type: "viewport.set",
        width: 1_440,
      }),
    ).toEqual({ height: 900, surfaceId: "page-1", type: "viewport.set", width: 1_440 });
    for (const invalid of [
      { height: 900, width: 1_440 },
      { height: 900.5, surfaceId: "page-1", width: 1_440 },
      { height: 4_320, surfaceId: "page-1", width: 7_680 },
      { devicePixelRatio: 2, height: 900, surfaceId: "page-1", width: 1_440 },
    ]) {
      expect(
        BrowserClientMessageSchema.safeParse({
          ...invalid,
          type: "viewport.set",
        }).success,
      ).toBe(false);
    }
    expect(
      BrowserClientMessageSchema.safeParse({
        devicePixelRatio: 2,
        height: 600,
        type: "stream.resize",
        width: 800,
      }).success,
    ).toBe(false);
    expect(
      BrowserClientMessageSchema.safeParse({
        action: "down",
        button: "left",
        surfaceId: "page-1",
        type: "input.pointer",
        x: 0.5,
        y: 0.5,
      }).success,
    ).toBe(false);
    expect(
      BrowserClientMessageSchema.parse({
        action: "down",
        button: "left",
        surfaceId: "page-1",
        type: "input.pointer",
        viewportHeight: 900,
        viewportWidth: 1_440,
        x: 0.5,
        y: 0.5,
      }),
    ).toMatchObject({ viewportHeight: 900, viewportWidth: 1_440 });
    expect(
      BrowserClientMessageSchema.safeParse({
        deltaX: 0,
        deltaY: 100,
        surfaceId: "page-1",
        type: "input.wheel",
        viewportHeight: 900,
        viewportWidth: 20_000,
        x: 0.5,
        y: 0.5,
      }).success,
    ).toBe(false);
  });

  it("requires one ready browser snapshot before terminal lifecycle events", () => {
    const snapshot = {
      access: "full-control",
      dialog: null,
      sessionId: `bsn_${randomUUID()}`,
      state: "ready",
      surfaces: [],
      type: "browser.snapshot",
    } as const;
    expect(BrowserServerMessageSchema.parse(snapshot)).toEqual(snapshot);
    expect(BrowserServerMessageSchema.safeParse({ ...snapshot, state: "starting" }).success).toBe(
      false,
    );
    expect(
      BrowserServerMessageSchema.safeParse({
        state: "ready",
        type: "browser.status",
      }).success,
    ).toBe(false);
    expect(
      BrowserServerMessageSchema.safeParse({
        state: "closing",
        type: "browser.status",
      }).success,
    ).toBe(true);
    const surface = {
      active: true,
      id: `surface_${randomUUID()}`,
      title: "Example",
      url: "https://example.com/",
    } as const;
    expect(
      BrowserServerMessageSchema.safeParse({ ...snapshot, surfaces: [surface, surface] }).success,
    ).toBe(false);
    expect(
      BrowserServerMessageSchema.safeParse({
        ...snapshot,
        surfaces: [{ ...surface, active: false }],
      }).success,
    ).toBe(false);
    expect(
      BrowserServerMessageSchema.safeParse({
        ...snapshot,
        surfaces: [surface, { ...surface, id: `surface_${randomUUID()}` }],
      }).success,
    ).toBe(false);
    const dialog = { id: randomUUID(), message: "Continue?", type: "confirm" } as const;
    expect(
      BrowserServerMessageSchema.safeParse({
        ...snapshot,
        dialog: { ...dialog, surfaceId: surface.id },
        surfaces: [surface],
      }).success,
    ).toBe(true);
    expect(
      BrowserServerMessageSchema.safeParse({
        ...snapshot,
        dialog: { ...dialog, surfaceId: "surface_missing" },
        surfaces: [surface],
      }).success,
    ).toBe(false);
  });

  it("keeps raw CDP commands and responses correlated and bounded", () => {
    const requestId = "00000000-0000-4000-8000-000000000301";
    expect(
      BrowserClientMessageSchema.parse({
        command: { method: "Browser.getVersion" },
        requestId,
        type: "cdp.command",
      }),
    ).toMatchObject({ requestId, type: "cdp.command" });
    expect(
      BrowserServerMessageSchema.parse({
        requestId,
        result: { product: "Chrome/151" },
        type: "cdp.result",
      }),
    ).toMatchObject({ requestId, type: "cdp.result" });
    expect(
      BrowserServerMessageSchema.parse({
        event: {
          method: "Page.loadEventFired",
          parameters: { timestamp: 1 },
          sequence: 1,
        },
        type: "cdp.event",
      }),
    ).toMatchObject({ type: "cdp.event" });
  });

  it("uses machine-scoped Workspace mount and detach commands", () => {
    const environmentId = createId("environment");
    const workspaceId = createId("workspace");
    const base = {
      commandId: createId("command"),
      correlationId: createId("command"),
      environmentId,
    };
    expect(
      RunnerCommandSchema.parse({
        ...base,
        plan: {
          createdBy: createId("user"),
          exchangeToken: "one-use-token",
          exchangeUrl: "https://host.example/internal/v1/mount-grants/exchange",
          generation: 4,
          kind: "portablefs",
          volumeId: "volume-4",
          workspaceId,
          workspaceKind: "specialized",
        },
        runId: createId("run"),
        threadId: createId("thread"),
        type: "workspace.mount",
        workspaceId,
      }),
    ).toMatchObject({ type: "workspace.mount", workspaceId });
    expect(
      RunnerCommandSchema.parse({
        ...base,
        type: "workspace.detach",
        volumeId: "volume-4",
        workspaceId,
      }),
    ).toMatchObject({ type: "workspace.detach", volumeId: "volume-4", workspaceId });
    expect(
      RunnerCommandSchema.safeParse({
        ...base,
        sourceWorkspaceId: workspaceId,
        targetWorkspaceId: workspaceId,
        type: "workspace.detach",
        volumeId: "volume-4",
        workspaceId,
      }).success,
    ).toBe(false);
  });

  it("parses bounded watch reconciliation and status messages", () => {
    const activationId = createId("triggerWatchActivation");
    const environmentId = createId("environment");
    const workspaceId = createId("workspace");
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const command = {
      commandId: createId("command"),
      correlationId: createId("command"),
      desired: [
        {
          activationId,
          anchorThreadId: createId("thread"),
          capabilities: {
            browserCdp: null,
            integrationMcp: { expiresAt, token: "integration-token", url: "https://host.test/mcp" },
            mcp: { expiresAt, token: "control-token", url: "https://host.test/mcp" },
          },
          executionGeneration: 2,
          revisionId: createId("triggerRevision"),
          triggerId: createId("trigger"),
          workspaceAccess: {
            bindingId: createId("workspaceBinding"),
            generation: 1,
            kind: "local-directory",
            ownerEnvironmentId: environmentId,
            storageAuthorityId: createId("storageAuthority"),
            workspaceId,
          },
          workspaceId,
        },
      ],
      environmentId,
      reconcileGeneration: 7,
      type: "watch.reconcile",
    } as const;
    expect(RunnerCommandSchema.parse(command)).toEqual(command);
    expect(
      RunnerCommandSchema.safeParse({
        ...command,
        desired: command.desired.map(({ ...item }) => ({ ...item, program: "inline" })),
      }).success,
    ).toBe(false);

    const status = {
      ...wireFence,
      activationId,
      executionGeneration: 2,
      healthySince: new Date().toISOString(),
      lastError: null,
      lastExitCode: null,
      observed: "running",
      restartCount: 0,
      stderrTail: "",
      stdoutTail: "ready\n",
      type: "runner.watch-status",
    } as const;
    expect(RunnerToHostMessageSchema.parse(status)).toEqual(status);
    expect(
      RunnerToHostMessageSchema.safeParse({ ...status, stdoutTail: "x".repeat(16 * 1_024 + 1) })
        .success,
    ).toBe(false);
  });

  it("fits a largest practical current message and bounded history in one Runner frame", () => {
    const threadId = createId("thread");
    const workspaceId = createId("workspace");
    const history: Message[] = [
      {
        author: {
          displayName: "User",
          kind: "human",
          principalId: "principal:test",
        },
        content: [{ text: "h".repeat(240 * 1_024), type: "text" }],
        createdAt: new Date().toISOString(),
        id: createId("message"),
        kind: "input",
        runId: createId("run"),
        sequence: "0" as Message["sequence"],
        threadId,
      },
    ];
    const base = {
      commandId: createId("command"),
      context: {
        accessMode: "full-access",
        assignment: null,
        threadRole: "work",
        threadState: { previousAssignment: null, previousRun: null },
        agentControl: {
          token: "agent-token",
          url: "https://host.example.test/internal/v1/agent-control",
        },
        agentTools: {
          capabilityProfileId: "main",
          token: "agent-tools-token",
          url: "https://host.example.test/internal/v1/mcp",
        },
        browserCdp: {
          token: "browser-cdp-token",
          url: "https://host.example.test/internal/v1/browser-cdp",
        },
        integrationTools: {
          token: "agent-tools-token",
          url: "https://host.example.test/internal/v1/integration-mcp",
        },
        integrationSkills: {
          token: "integration-skills-token",
          url: "https://host.example/internal/v1/integration-skills",
        },
        bindingGeneration: 1,
        executionLeaseMs: 90_000,
        membershipGeneration: 1,
        egress: {
          maxRequestBytes: 1_024,
          maxResponseBytes: 1_024,
          relayToken: "relay-token",
          relayUrl: "https://host.example.test/internal/v1/egress",
        },
        environmentId: createId("environment"),
        harness: {
          config: {},
          driverKind: "native",
          name: "Native",
          runtimeRevision: 1,
          sourceId: "native",
          stateKind: "isolated",
        },
        harnessInstanceId: createId("harnessInstance"),
        history,
        historyWindow: {
          byteCount: new TextEncoder().encode(JSON.stringify(history)).byteLength,
          hasEarlier: true,
          itemCount: 1,
        },
        modelSelection: {
          modelId: "gpt-5.6-sol",
          options: { effort: "low" },
          providerId: "openai",
        },
        machineAccess: { callerMachineName: "Alex's Mac", machines: [], omittedMachines: 0 },
        initialContext: null,
        providerSessionId: createId("providerSession"),
        providerSessionReference: null,
        providerSessionStateLayout: "session",
        requestedBy: createId("user"),
        requesterTimeZone: "America/New_York",
        runId: createId("run"),
        threadId,
        workspaceId,
        workspaceKind: "main",
        workspaceInstructionsPath: "AGENTS.md",
        workspaceAccess: {
          createdBy: createId("user"),
          exchangeToken: "exchange-token",
          exchangeUrl: "https://host.example.test/internal/v1/mount-grants/exchange",
          generation: 1,
          kind: "portablefs",
          volumeId: "volume-1",
          workspaceId,
          workspaceKind: "main",
        },
      },
      correlationId: createId("command"),
      environmentId: createId("environment"),
      inputs: [
        {
          author: {
            displayName: "User",
            kind: "human",
            principalId: "principal:test",
          },
          content: [{ text: "c".repeat(240 * 1_024), type: "text" }],
          createdAt: new Date().toISOString(),
          kind: "input",
          messageId: createId("message"),
        },
      ],
      reports: { messages: [], omittedCount: 0, throughSequence: null },
      type: "run.execute" as const,
    };

    const parsed = RunnerCommandSchema.safeParse(base);
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    expect(RunnerCommandSchema.safeParse({ ...base, inputs: [] }).success).toBe(false);
    expect(
      RunnerCommandSchema.safeParse({
        ...base,
        inputs: [base.inputs[0], base.inputs[0]],
      }).success,
    ).toBe(false);
    expect(
      RunnerCommandSchema.safeParse({
        ...base,
        inputs: [{ ...base.inputs[0], kind: "assistant" }],
      }).success,
    ).toBe(false);
    const agentAuthor = {
      displayName: "Research agent",
      kind: "agent" as const,
      runId: createId("run"),
      threadId: createId("thread"),
      workspaceId: createId("workspace"),
      workspaceName: "Research",
    };
    expect(
      RunnerCommandSchema.safeParse({
        ...base,
        reports: {
          messages: [{ ...base.inputs[0], author: agentAuthor, kind: "run-result" as const }],
          omittedCount: 1,
          throughSequence: "42",
        },
      }).success,
    ).toBe(true);
    expect(
      RunnerCommandSchema.safeParse({
        ...base,
        reports: { messages: [base.inputs[0]], omittedCount: 0, throughSequence: "42" },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...base.inputs[0], kind: "run-result" as const },
      { ...base.inputs[0], author: agentAuthor, kind: "continuation" as const },
      {
        ...base.inputs[0],
        author: { cause: "test", kind: "platform" as const },
        kind: "input" as const,
      },
    ]) {
      expect(RunnerCommandSchema.safeParse({ ...base, inputs: [invalid] }).success).toBe(false);
    }
    expect(
      RunnerCommandSchema.safeParse({
        ...base,
        context: {
          ...base.context,
          harness: { ...base.context.harness, config: { padding: "x".repeat(600 * 1_024) } },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects Host-authored place entries from runners", () => {
    expect(
      PendingAgentEventSchema.safeParse({
        type: "place.entered",
        bindingGeneration: 1,
        emittedAt: new Date().toISOString(),
        environmentId: createId("environment"),
        ordinal: 0,
        runId: createId("run"),
        threadId: createId("thread"),
        workspaceId: createId("workspace"),
        data: {
          place: {
            kind: "browser",
            sessionId: "bsn_11111111-1111-4111-8111-111111111111",
            surfaceId: "A",
          },
          title: "Page",
          site: null,
        },
      }).success,
    ).toBe(false);
  });

  it("accepts bounded canonical tool output and rejects provider-native or oversized output", () => {
    const base = {
      bindingGeneration: 1,
      emittedAt: new Date().toISOString(),
      environmentId: createId("environment"),
      ordinal: 0,
      runId: createId("run"),
      threadId: createId("thread"),
      type: "tool.completed" as const,
      workspaceId: createId("workspace"),
    };
    expect(
      PendingAgentEventSchema.safeParse({
        ...base,
        data: { callId: "call-1", isError: false, output: { text: "x".repeat(50 * 1_024) } },
      }).success,
    ).toBe(true);
    expect(
      PendingAgentEventSchema.safeParse({
        ...base,
        data: { callId: "call-1", isError: false, output: { text: "x".repeat(50 * 1_024 + 1) } },
      }).success,
    ).toBe(false);
    expect(
      PendingAgentEventSchema.safeParse({
        ...base,
        data: { callId: "call-1", isError: false, output: { stdout: "provider envelope" } },
      }).success,
    ).toBe(false);
  });

  it("fits largest catalog and single-message tool pages but rejects an oversized combined page", () => {
    const requestId = randomUUID();
    const harnessIds = Array.from({ length: 64 }, () => createId("harnessInstance"));
    const environments = Array.from({ length: 64 }, (_, index) => ({
      compatibleHarnessInstanceIds: harnessIds,
      connected: true,
      id: createId("environment"),
      kind: index === 0 ? ("main" as const) : ("local" as const),
      name: "e".repeat(120),
      workspaceBackings: ["local-directory" as const, "portablefs" as const],
    }));
    const threads = Array.from({ length: 100 }, () => {
      const id = createId("thread");
      return {
        accessMode: "full-access" as const,
        capabilityProfileId: "main" as const,
        continuationIdentity: null,
        createdAt: new Date().toISOString(),
        createdBy: createId("user"),
        environmentId: createId("environment"),
        harnessInstanceId: harnessIds[0],
        id,
        inputQueuePaused: false,
        lineageRootThreadId: id,
        modelSelection: {
          modelId: "gpt-5.6-sol",
          options: { effort: "low" },
          providerId: "openai",
        },
        listed: true,
        parentThreadId: null,
        pendingRequests: 0,
        role: "work" as const,
        status: "idle" as const,
        title: "t".repeat(240),
        updatedAt: new Date().toISOString(),
        workspaceId: createId("workspace"),
      };
    });
    const window = {
      byteCount: 64 * 1_024,
      hasMore: true,
      itemCount: 100,
      nextBefore: "cursor",
      totalItems: 101,
    };
    // Every model an inspection may show, each at its longest names.
    const longestModel = (index: number) => ({
      modelId: `${index}`.padEnd(255, "m"),
      providerId: `p${index}`.padEnd(100, "p"),
    });
    const catalog = AgentControlResponseSchema.parse({
      delegationDefault: {
        environmentId: environments[0]!.id,
        harnessInstanceId: harnessIds[0],
        model: {
          ...longestModel(0),
          options: Object.fromEntries(
            Array.from({ length: 16 }, (_, option) => [`o${option}`.padEnd(100, "o"), true]),
          ),
        },
      },
      environments,
      environmentsTruncated: false,
      harnesses: harnessIds.map((id, index) => ({
        driverKind: "d".repeat(100),
        enabled: true,
        environmentId: environments[index % environments.length]!.id,
        id,
        models:
          index < 5
            ? Array.from({ length: 20 }, (_, model) => longestModel(index * 20 + model))
            : [],
        modelsOmitted: index < 5 ? 8_172 : 0,
        name: "h".repeat(120),
      })),
      harnessesTruncated: false,
      requestId,
      threads,
      threadWindow: window,
      type: "workspace.inspect.result",
      workspaces: Array.from({ length: 50 }, () => ({
        id: createId("workspace"),
        kind: "specialized" as const,
        name: "w".repeat(160),
        status: "ready" as const,
      })),
      workspaceWindow: { ...window, itemCount: 50 },
    });
    expect(Buffer.byteLength(JSON.stringify(catalog), "utf8")).toBeLessThanOrEqual(
      agentToolPayloadMaxSerializedBytes,
    );

    const threadId = createId("thread");
    const thread = { ...threads[0], id: threadId };
    const largeMessage = {
      author: {
        displayName: "User",
        kind: "human" as const,
        principalId: "principal:test",
      },
      content: [{ text: "m".repeat(256 * 1_024), type: "text" as const }],
      createdAt: new Date().toISOString(),
      id: createId("message"),
      kind: "input" as const,
      runId: createId("run"),
      sequence: "0" as Message["sequence"],
      threadId,
    };
    const readWindow = { ...window, byteCount: 300 * 1_024, itemCount: 1, threadId };
    expect(
      AgentControlResponseSchema.safeParse({
        assignments: [],
        assignmentWindow: {
          byteCount: 2,
          hasMore: false,
          itemCount: 0,
          nextBefore: null,
          totalItems: 0,
        },
        messages: [largeMessage],
        requestId,
        thread,
        type: "thread.read.result",
        window: readWindow,
      }).success,
    ).toBe(true);
    expect(
      AgentControlResponseSchema.safeParse({
        messages: [largeMessage, { ...largeMessage, id: createId("message") }],
        requestId,
        thread,
        type: "thread.read.result",
        window: { ...readWindow, byteCount: 600 * 1_024, itemCount: 2 },
      }).success,
    ).toBe(false);
  });

  it("fits a full Thread listing page and requires explicit agent message delivery", () => {
    const requestId = randomUUID();
    const listing = AgentControlResponseSchema.parse({
      requestId,
      threads: Array.from({ length: 50 }, () => ({
        environmentConnected: true,
        environmentId: createId("environment"),
        id: createId("thread"),
        parentThreadId: createId("thread"),
        pendingRequests: 2,
        status: "running" as const,
        title: "t".repeat(240),
        updatedAt: new Date().toISOString(),
        workspaceId: createId("workspace"),
        workspaceName: "w".repeat(160),
      })),
      type: "thread.list.result",
      window: {
        byteCount: 64 * 1_024,
        hasMore: true,
        itemCount: 50,
        nextBefore: "cursor",
        totalItems: 500,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(listing), "utf8")).toBeLessThanOrEqual(
      agentToolPayloadMaxSerializedBytes,
    );
    expect(
      AgentControlResponseSchema.safeParse({
        ...listing,
        threads: [...(listing.type === "thread.list.result" ? listing.threads : []), listing],
      }).success,
    ).toBe(false);

    const untitled = AgentControlRequestSchema.parse({
      content: [{ text: "Status?", type: "text" }],
      delivery: "queue",
      requestId,
      threadId: createId("thread"),
      type: "thread.message",
    });
    expect(untitled).toMatchObject({ delivery: "queue" });
    expect(
      AgentControlRequestSchema.safeParse({
        content: [{ text: "Status?", type: "text" }],
        requestId,
        threadId: createId("thread"),
        type: "thread.message",
      }).success,
    ).toBe(false);
    for (const delivery of ["turn", "notify"] as const) {
      expect(
        AgentControlRequestSchema.safeParse({
          content: [{ text: "Status?", type: "text" }],
          delivery,
          requestId,
          threadId: createId("thread"),
          type: "thread.message",
        }).success,
      ).toBe(false);
    }
    expect(
      AgentControlRequestSchema.parse({ limit: 50, requestId, type: "thread.list" }),
    ).toMatchObject({ limit: 50 });
    expect(AgentControlRequestSchema.parse({ requestId, type: "thread.list" })).toMatchObject({
      limit: 25,
    });
    expect(
      AgentControlRequestSchema.safeParse({ limit: 51, requestId, type: "thread.list" }).success,
    ).toBe(false);
  });

  it("rejects duplicate and unbounded Runner harness advertisements", () => {
    const base = {
      challengeId: `rch_${randomUUID()}`,
      descriptor: {
        bootId: `rbt_${randomUUID()}`,
        capabilities: ["filesystem"],
        modules: {
          agents: {
            environmentIds: [createId("environment")],
            localStorage: null,
            maxConcurrentRuns: 1,
            providerStateModes: ["isolated"],
            workspaceBackings: ["portablefs"],
            workspaceMounts: [],
          },
        },
        name: "Main runner",
        runnerId: createId("runner"),
        runnerKind: "main",
        runtimeVersion: "0.0.0",
      },
      credential: { enrollmentToken: "e".repeat(32), kind: "host-enrollment-token" },
      publicKeyPem: `-----BEGIN PUBLIC KEY-----\n${"a".repeat(64)}\n-----END PUBLIC KEY-----\n`,
      signature: "s".repeat(86),
      proofFormatVersion: 2,
      type: "runner.enroll",
    };
    expect(() =>
      RunnerToHostMessageSchema.parse({
        ...base,
        descriptor: {
          ...base.descriptor,
          modules: {
            agents: {
              ...base.descriptor.modules.agents,
              harnessDrivers: [
                {
                  accessModes: [...ThreadAccessModeSchema.options],
                  driverKind: "native",
                  readiness: "configured",
                  sources: harnessSources("native", "Native"),
                },
                {
                  accessModes: [...ThreadAccessModeSchema.options],
                  driverKind: "native",
                  readiness: "runtime-check",
                  sources: harnessSources("native", "Native"),
                },
              ],
            },
          },
        },
      }),
    ).toThrow(/advertised more than once/);
    expect(() =>
      RunnerToHostMessageSchema.parse({
        ...base,
        descriptor: {
          ...base.descriptor,
          modules: {
            agents: {
              ...base.descriptor.modules.agents,
              harnessDrivers: Array.from({ length: 101 }, (_, index) => ({
                accessModes: [...ThreadAccessModeSchema.options],
                driverKind: `driver-${index}`,
                readiness: "configured",
                sources: harnessSources("native", "Native"),
              })),
            },
          },
        },
      }),
    ).toThrow();
  });

  it("decodes and validates browser frame envelopes without copying image bytes", () => {
    const header = new TextEncoder().encode(
      JSON.stringify({
        encoding: "jpeg",
        frameId: 7,
        rasterHeight: 720,
        rasterWidth: 1280,
        surfaceId: "page-1",
        viewportHeight: 720,
        viewportWidth: 1280,
      }),
    );
    const image = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const envelope = new Uint8Array(4 + header.byteLength + image.byteLength);
    new DataView(envelope.buffer).setUint32(0, header.byteLength, false);
    envelope.set(header, 4);
    envelope.set(image, 4 + header.byteLength);

    const decoded = decodeBrowserFrameEnvelope(envelope);

    expect(decoded.header.frameId).toBe(7);
    expect([...decoded.data]).toEqual([...image]);
    expect(decoded.data.buffer).toBe(envelope.buffer);
  });

  it("rejects browser frames whose declared encoding does not match the payload", () => {
    const header = new TextEncoder().encode(
      JSON.stringify({
        encoding: "png",
        frameId: 1,
        rasterHeight: 1,
        rasterWidth: 1,
        surfaceId: "page-1",
        viewportHeight: 1,
        viewportWidth: 1,
      }),
    );
    const envelope = new Uint8Array(4 + header.byteLength + 2);
    new DataView(envelope.buffer).setUint32(0, header.byteLength, false);
    envelope.set(header, 4);
    envelope.set([0xff, 0xd8], 4 + header.byteLength);

    expect(() => decodeBrowserFrameEnvelope(envelope)).toThrow(/encoding/);
  });
  it("binds a Browser Session to exactly one immutable identity", () => {
    const profileIdentity = {
      kind: "profile-local",
      initialized: true,
      readyUrl: "https://host.example.test/ready",
      binding: {
        version: 1,
        deploymentId: createId("deployment"),
        profileId: createId("browserProfile"),
        runnerId: createId("runner"),
        storageInstanceId: randomUUID(),
        bindingId: randomUUID(),
        engine: "chromium",
      },
    } as const;
    expect(BrowserAttachTicketIdentitySchema.parse(profileIdentity)).toEqual(profileIdentity);
    expect(BrowserAttachTicketIdentitySchema.parse({ kind: "fresh" })).toEqual({ kind: "fresh" });
    for (const invalid of [
      { ...profileIdentity, kind: "fresh" },
      { kind: "fresh", profileId: createId("browserProfile") },
      { ...profileIdentity, profileLeaseToken: "a".repeat(42) },
      { kind: "profile", profileId: createId("browserProfile") },
      {},
    ]) {
      expect(BrowserAttachTicketIdentitySchema.safeParse(invalid).success).toBe(false);
    }

    const claims = {
      operationExpiresAt: new Date(Date.now() + 18_000).toISOString(),
      remainingBudgetMs: 18_000,
      wireVersion: 1,
      access: "full-control",
      audience: "opensteer-browser-runtime",
      expiresAt: new Date().toISOString(),
      identity: { kind: "fresh" },
      issuedAt: new Date().toISOString(),
      nonce: "n".repeat(16),
      runtimeId: "hosted-browser-1",
      sessionId: `bsn_${randomUUID()}`,
      subject: "usr_browser-subject",
    } as const;
    expect(BrowserAttachTicketClaimsSchema.parse(claims)).toEqual(claims);
    expect(
      BrowserAttachTicketClaimsSchema.safeParse({
        ...claims,
        identity: undefined,
        profileId: createId("browserProfile"),
      }).success,
    ).toBe(false);
  });

  it("names a fresh Browser Session by the absence of a profile", () => {
    const session = {
      access: "full-control",
      createdAt: new Date().toISOString(),
      id: `bsn_${randomUUID()}`,
      origin: "agent",
      placement: { kind: "runner", runnerId: createId("runner") },
      profileId: null,
      runtimeId: "hosted-browser-1",
      state: "ready",
      updatedAt: new Date().toISOString(),
      workspaceId: createId("workspace"),
    } as const;
    expect(HostedBrowserSessionSchema.parse(session)).toEqual(session);
    const summary = {
      ...session,
      activeAttachmentCount: 0,
      attached: true,
      profileName: null,
    } as const;
    expect(AgentBrowserSessionSummarySchema.parse(summary)).toEqual(summary);
    expect(
      AgentBrowserSessionSummarySchema.safeParse({ ...summary, profileName: "" }).success,
    ).toBe(false);
  });

  it("requires an explicit identity when a Workspace opens a Browser Session", () => {
    const runnerId = createId("runner");
    expect(
      StartHostedBrowserBodySchema.parse({
        fresh: true,
        placement: { kind: "runner", runnerId },
      }),
    ).toEqual({ fresh: true, placement: { kind: "runner", runnerId }, reuseExisting: false });
    const profileId = createId("browserProfile");
    expect(StartHostedBrowserBodySchema.parse({ profileId })).toEqual({
      profileId,
      reuseExisting: false,
    });
    for (const invalid of [
      {},
      { profileId, fresh: true },
      { fresh: false },
      { placement: { kind: "runner", runnerId } },
    ]) {
      expect(StartHostedBrowserBodySchema.safeParse(invalid).success).toBe(false);
    }
  });
});

/** One minimal first-party source, shaped exactly as a driver declares it. */
function harnessSources(sourceId: string, label: string) {
  return [
    {
      fields: [],
      kind: "first-party",
      label,
      quota: "none",
      sourceId,
      stateKinds: ["ambient", "isolated"],
    },
  ];
}
