import { describe, expect, it } from "vitest";
import { HarnessInstanceCatalogSchema } from "@opensteer/protocol";
import { ModelSelectionSchema, ThreadAccessModeSchema } from "@opensteer/core";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type {
  EnvironmentSummary,
  HarnessSummary,
  ThreadPlacementOption,
  WorkspaceSummary,
} from "@opensteer/client/host";
import { newThreadPlaceholder, workspaceHealth } from "./home-view.js";

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    description: "",
    fileCount: 0,
    homeThreadId: null,
    harnessLabel: "Codex",
    icon: null,
    id: "workspace-main",
    kind: "main",
    machineName: null,
    name: "Main",
    runnerLabel: "Main",
    status: "ready",
    storageIssue: null,
    color: "blue",
    updatedAt: "2026-08-10T00:00:00.000Z",
    ...overrides,
  };
}

function environment(overrides: Partial<EnvironmentSummary> = {}): EnvironmentSummary {
  const connected = overrides.connected ?? true;
  return {
    capabilities: [],
    connected,
    harnessAuthenticationAllowed: true,
    workspaceBackings: ["local-directory"],
    harnessCatalogs: [
      HarnessInstanceCatalogSchema.parse({
        continuationIdentity: {
          continuationKey: "runner:v1:8tErnQuB1d-nw979Rab9a4JN0RE_tKRvI_Rtmy45Bbo",
          driverKind: "codex",
        },
        driverKind: "codex",
        harnessInstanceId: "hin_00000000-0000-4000-8000-000000000001",
        models: [
          {
            displayName: "GPT-5.6-Sol",
            isDefault: true,
            modelId: "gpt-5.6-sol",
            options: [],
            providerId: "openai",
          },
        ],
        status: "ready",
      }),
    ],
    harnessDrivers: [
      {
        accessModes: [...ThreadAccessModeSchema.options],
        driverKind: "codex",
        readiness: "runtime-check",
        sources: [
          {
            fields: [],
            kind: "first-party",
            label: "OpenAI",
            quota: "windows",
            sourceId: "openai",
            stateKinds: ["ambient", "isolated"],
          },
        ],
      },
    ],
    id: "environment-main",
    kind: "main",
    name: "Main",
    providerStateModes: ["isolated"],
    runnerId: null,
    status: connected ? "connected" : "disconnected",
    ...overrides,
  };
}

function harness(overrides: Partial<HarnessSummary> = {}): HarnessSummary {
  return {
    driverKind: "codex",
    enabled: true,
    environmentId: "environment-main",
    id: "hin_00000000-0000-4000-8000-000000000001",
    name: "Codex",
    isDefault: true,
    runtimeRevision: 1,
    sourceId: "openai",
    stateKind: "isolated",
    ...overrides,
  };
}

const healthySnapshot = { environments: [environment()], harnesses: [harness()] };

describe("workspaceHealth", () => {
  it("surfaces the storage failure reason and keeps attention on storage", () => {
    const health = workspaceHealth(
      workspace({
        status: "unavailable",
        storageIssue: {
          code: "manager-allocation-rejected",
          message: "Workspace storage needs more capacity before it can continue.",
          occurredAt: "2026-08-10T00:00:00.000Z",
          retryable: true,
        },
      }),
      healthySnapshot,
    );

    expect(health?.heading).toContain("storage needs attention");
    expect(health?.body).toBe("Workspace storage needs more capacity before it can continue.");
    expect(health?.action).not.toBeNull();
  });

  it("offers recovery while a Workspace is scheduled for deletion", () => {
    const health = workspaceHealth(workspace({ status: "deleting" }), healthySnapshot);

    expect(health?.heading).toContain("scheduled for deletion");
    expect(health?.blocking).toBe(true);
    expect(health?.action).not.toBeNull();
  });

  it("waits for a place to run work when no environment is connected", () => {
    const health = workspaceHealth(workspace(), {
      environments: [environment({ connected: false })],
      harnesses: [harness()],
    });

    expect(health?.heading).toBe("Waiting for a place to run work");
    expect(health?.body).toContain("No place to run work is connected");
    expect(health?.blocking).toBe(true);
  });

  it("reports the AI engine as unavailable when none is enabled", () => {
    const health = workspaceHealth(workspace(), {
      environments: [environment()],
      harnesses: [harness({ enabled: false })],
    });

    expect(health?.heading).toBe("Connect an AI service");
    expect(health?.body).toContain("Connect an account");
    expect(renderToStaticMarkup(<MemoryRouter>{health?.action}</MemoryRouter>)).toContain(
      'href="/settings/ai-engines"',
    );
  });

  it("says the account is getting ready, not to connect one, while it prepares", () => {
    const preparing = environment({
      harnessCatalogs: [
        HarnessInstanceCatalogSchema.parse({
          detail: "Preparing Codex2…",
          driverKind: "codex",
          harnessInstanceId: "hin_00000000-0000-4000-8000-000000000001",
          models: [],
          status: "preparing",
        }),
      ],
    });
    const health = workspaceHealth(workspace(), {
      environments: [preparing],
      harnesses: [harness({ name: "Codex2" })],
    });

    expect(health).toMatchObject({
      action: null,
      blocking: true,
      body: "This can take a few minutes after Opensteer starts. New Threads can start once it is done.",
      heading: "Codex2 is getting ready",
    });
  });

  it("reports nothing when the Workspace is ready to start Threads", () => {
    expect(workspaceHealth(workspace(), healthySnapshot)).toBeNull();
  });
});

describe("newThreadPlaceholder", () => {
  it("does not describe a ready Workspace as unready when model setup is the blocker", () => {
    expect(newThreadPlaceholder("ready", false)).toBe("Choose an available model to start.");
  });

  it("keeps storage readiness distinct from execution selection", () => {
    expect(newThreadPlaceholder("provisioning", true)).toBe("This Workspace is not ready yet.");
    expect(newThreadPlaceholder("ready", true)).toBe("What should Opensteer do?");
  });

  it("names the option the reader chose when that option is what blocks sending", () => {
    const blocked: ThreadPlacementOption = {
      accessModes: [...ThreadAccessModeSchema.options],
      availability: "disconnected",
      available: false,
      continuationIdentity: null,
      detail: "This work location is not connected",
      driverKind: "codex",
      accountName: "Codex Work",
      engineName: "Codex",
      defaultAccount: true,
      environmentId: "environment-studio",
      environmentKind: "local",
      harnessAuthenticationAllowed: true,
      harnessInstanceId: "hin-codex-work",
      models: [],
      modelSelection: ModelSelectionSchema.parse({
        modelId: "unavailable",
        options: {},
        providerId: "unavailable",
      }),
      observedConnections: [],
      setupAvailable: false,
      setupMethods: [],
      source: {
        fields: [],
        kind: "first-party",
        label: "OpenAI",
        quota: "windows",
        sourceId: "openai",
        stateKinds: ["ambient", "isolated"],
      },
      sourceId: "openai",
      whereLabel: "Studio Mac",
    };

    expect(newThreadPlaceholder("ready", false, blocked)).toBe(
      "Codex Work on Studio Mac is unavailable — choose another option or wait for it to reconnect.",
    );
    expect(newThreadPlaceholder("ready", false, { ...blocked, availability: "preparing" })).toBe(
      "Codex Work on Studio Mac is getting ready — wait for it or choose another option.",
    );
    // A blocked explicit choice outranks the generic "choose a model" prompt,
    // but never the Workspace's own unreadiness.
    expect(newThreadPlaceholder("provisioning", false, blocked)).toBe(
      "This Workspace is not ready yet.",
    );
  });
});
