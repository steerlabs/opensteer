import { createId } from "@opensteer/core";
import { slackChannelProviderManifest } from "@opensteer/channel-core";
import { describe, expect, it } from "vitest";
import {
  RunnerDescriptorSchema,
  RunnerHarnessDriverSchema,
  RunnerHarnessDriverViewSchema,
  RunnerWireProofSchema,
  RunnerCommandSchema,
} from "./runner.js";

const source = {
  sourceId: "openai",
  kind: "first-party",
  label: "OpenAI",
  quota: "none",
  stateKinds: ["isolated"],
  fields: [
    {
      id: "region",
      kind: "select",
      label: "Region",
      options: [{ label: "US", value: "us", future: true }],
      future: true,
    },
  ],
  future: true,
};
const driver = {
  driverKind: "codex",
  readiness: "configured",
  accessModes: ["full-access"],
  sources: [source],
  messageAttachments: {
    nativeImages: {
      maxBytes: 100,
      maxPixels: 100,
      mediaTypes: ["image/png"],
      steering: true,
      future: true,
    },
    future: true,
  },
  future: true,
};
function descriptor() {
  return {
    bootId: "rbt_11111111-1111-4111-8111-111111111111",
    runnerId: createId("runner"),
    runnerKind: "local",
    runtimeVersion: "test",
    name: " Runner ",
    capabilities: ["future-capability"],
    future: true,
    device: { form: "laptop", platform: "linux", future: true },
    modules: {
      agents: {
        environmentIds: [createId("environment")],
        harnessDrivers: [driver],
        localStorage: {
          storageAuthorityId: createId("storageAuthority"),
          bindings: [
            {
              bindingId: createId("workspaceBinding"),
              generation: 1,
              state: "ready",
              workspaceId: createId("workspace"),
              future: true,
            },
          ],
          truncated: false,
          future: true,
        },
        maxConcurrentRuns: 1,
        providerStateModes: ["isolated", "future-state"],
        workspaceBackings: ["local-directory", "future-backing"],
        workspaceMounts: [
          {
            enrollmentId: "enrollment",
            volumeId: "volume",
            workspaceId: createId("workspace"),
            future: true,
          },
        ],
        future: true,
      },
      browser: {
        runtimeId: "browser",
        signIn: { version: 2, future: true },
        targetControl: 1,
        future: true,
      },
      integrations: {
        platform: "darwin",
        protocolVersion: 5,
        ownerViewVersion: 2,
        macWindowVideoVersion: 1,
        future: true,
      },
      messaging: {
        capabilities: [
          {
            provider: "slack",
            transportKinds: ["socket", "future-transport"],
            manifest: {
              ...slackChannelProviderManifest,
              transportKinds: ["socket", "future-transport"],
              connectionMethods: [
                ...slackChannelProviderManifest.connectionMethods,
                "future-connection",
              ],
              credentialFields: slackChannelProviderManifest.credentialFields.map((field) => ({
                ...field,
                future: true,
              })),
              setupArtifact: {
                content: "setup",
                filename: "setup.txt",
                mediaType: "text/plain",
                future: true,
              },
              future: true,
            },
            future: true,
          },
        ],
        future: true,
      },
      futureModule: { required: true },
      future: true,
    },
  };
}

describe("the owning Runner descriptor reader", () => {
  it("accepts the computer tool and ignores unknown future Mac computer-use versions", () => {
    const wire = descriptor();
    const current = RunnerDescriptorSchema.parse({
      ...wire,
      modules: {
        ...wire.modules,
        agents: { ...wire.modules.agents, computerTool: 1 },
        integrations: { platform: "darwin", protocolVersion: 5, computerUseVersion: 2 },
      },
    });
    expect(current.modules.agents?.computerTool).toBe(1);
    expect(current.modules.integrations?.computerUseVersion).toBe(2);
    const future = RunnerDescriptorSchema.parse({
      ...wire,
      modules: {
        ...wire.modules,
        integrations: { platform: "darwin", protocolVersion: 5, computerUseVersion: 3 },
      },
    });
    expect(future.modules.integrations?.computerUseVersion).toBeUndefined();
  });

  it("strips nested extensions once and keeps understood alternatives and environment identity", () => {
    const wire = descriptor();
    const parsed = RunnerDescriptorSchema.parse(wire);
    expect(JSON.stringify(parsed)).not.toContain("future");
    expect(parsed.name).toBe("Runner");
    expect(parsed.modules.agents?.environmentIds).toEqual(wire.modules.agents.environmentIds);
    expect(parsed.modules.agents?.providerStateModes).toEqual(["isolated"]);
    expect(parsed.modules.messaging?.capabilities[0]?.transportKinds).toEqual(["socket"]);
    expect(RunnerHarnessDriverViewSchema.parse(driver)).toEqual(
      RunnerHarnessDriverSchema.parse(driver),
    );
  });

  it.each([true, undefined])(
    "omits sources with unknown required field kinds (required=%s)",
    (required) => {
      const wire = descriptor();
      const unsupported = {
        ...source,
        sourceId: "unsupported",
        fields: [
          {
            id: "future",
            label: "Future",
            kind: "future-field",
            ...(required === undefined ? {} : { required }),
          },
        ],
      };
      const parsed = RunnerDescriptorSchema.parse({
        ...wire,
        modules: {
          ...wire.modules,
          agents: {
            ...wire.modules.agents,
            harnessDrivers: [
              {
                ...driver,
                sources: [
                  source,
                  unsupported,
                  { ...source, sourceId: "future-source", kind: "future-kind" },
                ],
              },
              { driverKind: "future-driver", readiness: "future-readiness" },
            ],
          },
        },
      });
      const known = parsed.modules.agents?.harnessDrivers[0];
      expect(known?.readiness).toBe("configured");
      if (!known || known.readiness === "unavailable") throw new Error("Expected supported driver");
      expect(known.sources.map(({ sourceId }) => sourceId)).toEqual(["openai"]);
      expect(parsed.modules.agents?.harnessDrivers).toHaveLength(1);
    },
  );

  it("skips only independently optional unknown source fields", () => {
    const parsed = RunnerHarnessDriverSchema.parse({
      ...driver,
      accessModes: ["full-access", "future-access"],
      sources: [
        {
          ...source,
          stateKinds: ["isolated", "future-state"],
          fields: [
            ...source.fields,
            { id: "future", kind: "future-field", label: "Future", required: false },
          ],
        },
      ],
    });
    if (parsed.readiness === "unavailable") throw new Error("Expected supported driver");
    expect(parsed.accessModes).toEqual(["full-access"]);
    expect(parsed.sources[0]?.fields).toHaveLength(1);
  });

  it("disables unsupported optional feature versions", () => {
    const wire = descriptor();
    const parsed = RunnerDescriptorSchema.parse({
      ...wire,
      modules: {
        ...wire.modules,
        browser: {
          ...wire.modules.browser,
          signIn: { version: 9 },
          cdpBoundary: 9,
          sharedControl: 9,
          targetControl: 9,
          captureRegion: 9,
        },
        integrations: { ...wire.modules.integrations, macWindowVideoVersion: 9 },
      },
    });
    expect(parsed.modules.browser?.signIn).toBeUndefined();
    expect(parsed.modules.browser?.targetControl).toBeUndefined();
    expect(parsed.modules.browser?.cdpBoundary).toBeUndefined();
    expect(parsed.modules.browser?.sharedControl).toBeUndefined();
    expect(parsed.modules.browser?.captureRegion).toBeUndefined();
    expect(parsed.modules.integrations?.macWindowVideoVersion).toBeUndefined();
  });

  it("refuses unsupported inventory states and empty required state/backing sets without erasing agents", () => {
    const wire = descriptor();
    for (const agents of [
      { ...wire.modules.agents, providerStateModes: ["future-state"] },
      { ...wire.modules.agents, workspaceBackings: ["future-backing"] },
      {
        ...wire.modules.agents,
        localStorage: {
          ...wire.modules.agents.localStorage,
          bindings: [{ ...wire.modules.agents.localStorage.bindings[0], state: "future-state" }],
        },
      },
    ])
      expect(
        RunnerDescriptorSchema.safeParse({ ...wire, modules: { ...wire.modules, agents } }).success,
      ).toBe(false);
  });

  it("keeps known semantic refinements and required semantics validated", () => {
    const wire = descriptor();
    const invalid = [
      { ...wire, runnerKind: "future-kind" },
      { ...wire, device: { form: "future-form", platform: "linux" } },
      {
        ...wire,
        modules: { ...wire.modules, agents: { ...wire.modules.agents, localStorage: null } },
      },
      {
        ...wire,
        modules: { ...wire.modules, agents: { ...wire.modules.agents, environmentIds: [] } },
      },
      {
        ...wire,
        modules: {
          ...wire.modules,
          agents: { ...wire.modules.agents, harnessDrivers: [driver, driver] },
        },
      },
      {
        ...wire,
        modules: {
          ...wire.modules,
          agents: {
            ...wire.modules.agents,
            harnessDrivers: [{ ...driver, sources: [source, source] }],
          },
        },
      },
      { ...wire, modules: { ...wire.modules, integrations: { platform: "future-platform" } } },
      {
        ...wire,
        modules: {
          ...wire.modules,
          messaging: {
            capabilities: [
              {
                provider: "slack",
                transportKinds: ["socket"],
                manifest: { ...slackChannelProviderManifest, actorDelivery: "future-delivery" },
              },
            ],
          },
        },
      },
    ];
    for (const value of invalid)
      expect(RunnerDescriptorSchema.safeParse(value).success).toBe(false);
  });

  it("keeps raw proof envelopes and operational commands strict", () => {
    expect(
      RunnerWireProofSchema.safeParse({
        type: "runner.authenticate",
        challengeId: "rch_11111111-1111-4111-8111-111111111111",
        proofFormatVersion: 2,
        descriptor: descriptor(),
        signature: "a".repeat(86),
        future: true,
      }).success,
    ).toBe(false);
    expect(
      RunnerCommandSchema.safeParse({
        type: "run.interrupt",
        commandId: createId("command"),
        correlationId: "correlation",
        environmentId: createId("environment"),
        runId: createId("run"),
        threadId: createId("thread"),
        future: true,
      }).success,
    ).toBe(false);
  });
});
