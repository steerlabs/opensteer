import { readFileSync } from "node:fs";
import path from "node:path";
import {
  AgentPhoneSetupStatusSchema,
  AndroidPhoneActResultSchema,
  AndroidPhoneInstalledAppsResultSchema,
  AndroidPhoneObservationResultSchema,
  IntegrationsModuleEventSchema,
  RunnerAuxiliaryAuthenticateSchema,
  RunnerAuxiliaryChallengeSchema,
  RunnerAuxiliaryHeartbeatSchema,
  RunnerChallengeSchema,
  RunnerToHostMessageSchema,
  RunnerIntegrationsModuleSchema,
  agentPhonePackageName,
} from "@opensteer/protocol";
import { describe, expect, it } from "vitest";
import { verifyRunnerAuxiliarySignature } from "./auxiliary.js";
import { verifyRunnerAuthenticationSignature, verifyRunnerEnrollmentSignature } from "./proof.js";

/**
 * The Agent Phone's side of the wire, as the phone itself encodes it.
 *
 * `wire-fixture.json` is written by the Kotlin app's own JVM test from its
 * production encoders (`WireFixtureTest`), so this test is the two ends
 * agreeing: the Kotlin side that the file is what the phone sends, this side
 * that every frame is what the Host's schemas accept and every signature is
 * one these verifiers — the Host's own — accept. A change on either end fails
 * exactly one of the two. It lives beside the verifiers because
 * `@opensteer/protocol` cannot depend on this package.
 */
const fixturePath = path.resolve(
  import.meta.dirname,
  "../../../apps/agent-phone/app/src/test/resources/wire-fixture.json",
);

interface WireFixture {
  readonly auxiliary: Readonly<Record<string, unknown>>;
  readonly context: {
    readonly auxiliaryChallenge: unknown;
    readonly challenge: unknown;
    readonly runnerPublicKeyPem: string;
    readonly verifyAt: string;
  };
  readonly integrations: Readonly<Record<string, unknown>>;
  readonly primary: Readonly<Record<string, unknown>>;
  readonly setupStatus: Readonly<Record<string, unknown>>;
  readonly version: 1;
}

const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as WireFixture;
const verifyAt = Date.parse(fixture.context.verifyAt);
const challenge = RunnerChallengeSchema.parse(fixture.context.challenge);

interface Schema {
  safeParse(value: unknown): { readonly error?: { readonly issues: readonly unknown[] } };
}

function issues(schema: Schema, value: unknown): readonly unknown[] {
  return schema.safeParse(value).error?.issues ?? [];
}

function computerUseValue(name: string): unknown {
  const event = IntegrationsModuleEventSchema.parse(fixture.integrations[name]);
  if (event.type !== "runner.integrations.computer-use-result" || event.result.kind !== "ok") {
    throw new Error(`${name} is not a successful computer-use answer`);
  }
  return event.result.value;
}

describe("agent phone wire fixture", () => {
  it("is the fixture this test reads", () => {
    expect(fixture.version).toBe(1);
  });

  it("sends primary frames the Host parses, each under its own type", () => {
    const types: Record<string, string> = {
      authenticate: "runner.authenticate",
      enroll: "runner.enroll",
      heartbeat: "runner.heartbeat",
      modulesReport: "runner.modules.report",
      ticketRequest: "runner.auxiliary.ticket-request",
    };
    expect(Object.keys(fixture.primary).sort()).toEqual(Object.keys(types).sort());
    for (const [name, frame] of Object.entries(fixture.primary)) {
      expect(issues(RunnerToHostMessageSchema, frame), name).toEqual([]);
      expect(RunnerToHostMessageSchema.parse(frame).type).toBe(types[name]);
    }
  });

  it("enrolls and authenticates with signatures the Host verifies", () => {
    const enroll = RunnerToHostMessageSchema.parse(fixture.primary.enroll);
    const authenticate = RunnerToHostMessageSchema.parse(fixture.primary.authenticate);
    if (enroll.type !== "runner.enroll" || authenticate.type !== "runner.authenticate") {
      throw new Error("expected the two proofs");
    }
    expect(enroll.publicKeyPem).toBe(fixture.context.runnerPublicKeyPem);
    expect(enroll.descriptor).toEqual({
      bootId: expect.any(String),
      capabilities: [],
      device: { form: "phone", platform: "android" },
      modules: {
        integrations: {
          platform: "android",
          protocolVersion: 4,
        },
      },
      name: expect.any(String),
      runnerId: expect.any(String),
      runnerKind: "local",
      runtimeVersion: expect.any(String),
    });
    expect(
      verifyRunnerEnrollmentSignature(
        enroll.publicKeyPem,
        {
          challenge,
          credential: enroll.credential,
          descriptor: enroll.descriptor,
          publicKeyPem: enroll.publicKeyPem,
          signature: enroll.signature,
        },
        verifyAt,
      ),
    ).toBe(true);
    expect(
      verifyRunnerAuthenticationSignature(
        fixture.context.runnerPublicKeyPem,
        { challenge, descriptor: authenticate.descriptor, signature: authenticate.signature },
        verifyAt,
      ),
    ).toBe(true);
  });

  it("opens the integrations stream with a proof over its ticket", () => {
    const authenticate = RunnerAuxiliaryAuthenticateSchema.parse(fixture.auxiliary.authenticate);
    expect(issues(RunnerAuxiliaryHeartbeatSchema, fixture.auxiliary.heartbeat)).toEqual([]);
    expect(
      verifyRunnerAuxiliarySignature(
        fixture.context.runnerPublicKeyPem,
        {
          bootId: authenticate.bootId,
          challenge: RunnerAuxiliaryChallengeSchema.parse(fixture.context.auxiliaryChallenge),
          module: authenticate.module,
          runnerId: authenticate.runnerId,
          signature: authenticate.signature,
          ticket: authenticate.ticket,
        },
        verifyAt,
      ),
    ).toBe(true);
  });

  it("sends every integrations event the Host parses", () => {
    const types = new Set<string>();
    for (const [name, frame] of Object.entries(fixture.integrations)) {
      expect(issues(IntegrationsModuleEventSchema, frame), name).toEqual([]);
      types.add(IntegrationsModuleEventSchema.parse(frame).type);
    }
    // Everything a phone sends; it never opens an MCP session, so it never relays one.
    expect([...types].sort()).toEqual([
      "runner.integrations.computer-use-event",
      "runner.integrations.computer-use-result",
      "runner.integrations.mcp.closed",
      "runner.integrations.result",
      "runner.integrations.status",
    ]);
  });

  it("answers each computer-use operation with its Android phone schema", () => {
    const answers = Object.keys(fixture.integrations).filter(
      (name) =>
        IntegrationsModuleEventSchema.parse(fixture.integrations[name]).type ===
        "runner.integrations.computer-use-result",
    );
    expect(answers.sort()).toEqual([
      "act",
      "actExpired",
      "actOpensteerApp",
      "actOutOfTime",
      "actStale",
      "actStopped",
      "busy",
      "close",
      "installedApps",
      "observe",
      "observeOpensteerApp",
      "observeScreenOff",
      "observeWithoutScreenshot",
    ]);
    const schemas: Readonly<Record<string, Schema>> = {
      act: AndroidPhoneActResultSchema,
      actOutOfTime: AndroidPhoneActResultSchema,
      actStopped: AndroidPhoneActResultSchema,
      installedApps: AndroidPhoneInstalledAppsResultSchema,
      observe: AndroidPhoneObservationResultSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      expect(issues(schema, computerUseValue(name)), name).toEqual([]);
    }
    expect(computerUseValue("close")).toEqual({});
  });

  it("answers a batch cut by its deadline with what it did, and work that never started as not done", () => {
    expect(AndroidPhoneActResultSchema.parse(computerUseValue("actOutOfTime"))).toMatchObject({
      error: { code: "failed" },
      observation: null,
      performed: ['Tapped "Send"'],
    });
    const expired = IntegrationsModuleEventSchema.parse(fixture.integrations.actExpired);
    if (expired.type !== "runner.integrations.computer-use-result") {
      throw new Error("expected a computer-use answer");
    }
    expect(expired.result).toEqual({
      code: "failed",
      kind: "error",
      message: "The request expired before it ran.",
    });
  });

  it("names the stopped Run, so a Host that forgot the session still holds the Stop", () => {
    const event = IntegrationsModuleEventSchema.parse(fixture.integrations.stopped);
    if (event.type !== "runner.integrations.computer-use-event") {
      throw new Error("expected a computer-use event");
    }
    expect(event.event).toEqual({
      event: "session.stopped",
      params: {
        reason: "user",
        runId: "run_dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        sessionId: "cus_cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      },
    });
  });

  it("lists the apps launch can open, never the Opensteer app itself", () => {
    const listed = AndroidPhoneInstalledAppsResultSchema.parse(computerUseValue("installedApps"));
    expect(listed.apps.map((app) => app.packageName)).not.toContain(agentPhonePackageName);
    expect(listed.total).toBe(listed.apps.length);
  });

  it("refuses to operate the Opensteer app with the code computer use names it by", () => {
    const event = IntegrationsModuleEventSchema.parse(fixture.integrations.actOpensteerApp);
    if (event.type !== "runner.integrations.computer-use-result") {
      throw new Error("expected a computer-use answer");
    }
    expect(event.result).toEqual({
      code: "app-not-allowed",
      kind: "error",
      message:
        "The Opensteer Agent Phone app is in front, and agents may not operate it. Navigate home or launch another app first.",
    });
  });

  it("shares nothing of the screen while it is dark or the Opensteer app is in front", () => {
    const observation = (name: string) =>
      AndroidPhoneObservationResultSchema.parse(computerUseValue(name)).observation;
    expect(observation("observeWithoutScreenshot")).toMatchObject({
      screenshot: null,
      screenshotUnavailable: "not-requested",
    });
    expect(observation("observeScreenOff")).toMatchObject({
      elementCount: 0,
      screen: "off",
      screenshot: null,
      screenshotUnavailable: "screen-off",
      tree: "",
      truncated: false,
    });
    // The app is named, so an agent knows why it sees nothing and that leaving is its move.
    expect(observation("observeOpensteerApp")).toMatchObject({
      elementCount: 0,
      foreground: { label: "Opensteer Agent Phone", packageName: agentPhonePackageName },
      screen: "on",
      screenshot: null,
      screenshotUnavailable: "opensteer-app",
      tree: "",
      truncated: false,
    });
  });

  it("reports setup status without any secret", () => {
    expect(Object.keys(fixture.setupStatus).sort()).toEqual([
      "expired",
      "online",
      "protocolError",
      "unpaired",
    ]);
    for (const [name, status] of Object.entries(fixture.setupStatus)) {
      expect(issues(AgentPhoneSetupStatusSchema, status), name).toEqual([]);
      expect(JSON.stringify(status)).not.toMatch(/token|PRIVATE KEY/iu);
      const parsed = AgentPhoneSetupStatusSchema.parse(status);
      if (parsed.pairing) expect(parsed.pairing.deploymentName).toBe("Mac mini");
    }
  });
});

it("treats unknown phone owner-control versions as unsupported", () => {
  const baseline = { platform: "android", protocolVersion: 4, sharedInput: 1 };
  expect(
    RunnerIntegrationsModuleSchema.parse({ ...baseline, phoneOwnerControl: 1 }).phoneOwnerControl,
  ).toBe(1);
  expect(
    RunnerIntegrationsModuleSchema.parse({ ...baseline, phoneOwnerControl: 2 }).phoneOwnerControl,
  ).toBeUndefined();
  expect(RunnerIntegrationsModuleSchema.parse(baseline).phoneOwnerControl).toBeUndefined();
});
