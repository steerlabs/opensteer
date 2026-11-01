import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ModelSelectionSchema,
  zeroSequence,
  type AgentEventView as AgentEvent,
  type RunId,
} from "../packages/core/src/index.js";
import type { LaunchedBrowser } from "../packages/browser-runtime-core/src/index.js";
import { serveHarnessActionsFixture } from "../packages/browser-runtime-core/src/test-support/harness-actions-fixture.js";
import { nativeUserHarnessRuntimeBoundary } from "../packages/harness/src/index.js";
import { parseAgentExecutionConfig } from "../apps/runner/src/app-config.js";
import { createHarnessRegistry } from "../apps/runner/src/harness/harness-registry.js";
import {
  qualificationAccount,
  qualifiedVersion,
  shippedEnginesFirstOnPath,
  type QualifiedEngine,
} from "../apps/host/src/agents/engine-qualification.test-support.js";
import {
  startVerticalStack,
  type VerticalStack,
} from "../apps/host/src/agents/vertical-stack.test-support.js";
import {
  addCleanup,
  browserAvailable,
  browserHarness,
  executablePath,
  startBrowser,
} from "./browser-deployment.test-support.js";

// No test-only skill filtering: the production stack supplies all bundled
// Opensteer guidance. The prompt supplies only the person's business goal.
const engines: readonly QualifiedEngine[] = [
  {
    driverKind: "claude",
    sourceId: "anthropic",
    stateKind: "ambient",
    executable: "installed",
    label: "Claude",
  },
  {
    driverKind: "codex",
    sourceId: "openai",
    stateKind: "ambient",
    executable: "shipped",
    label: "Codex",
  },
];
const filter = process.env.OPENSTEER_PROFILE_ENGINE;
if (filter !== undefined) z.enum(["claude", "codex"]).parse(filter);
const matrix = engines.filter((engine) => filter === undefined || engine.driverKind === filter);
const skillRoot = fileURLToPath(new URL("../apps/runner/agent-skills/skills/", import.meta.url));
const harnessRoot = path.dirname(browserHarness);
const submissionSchema = z.object({
  nonce: z.string(),
  capacity: z.string(),
  zip: z.string(),
  count: z.number().int(),
  resultId: z.string().min(1),
  availability: z.string().min(1),
});
const pageStateSchema = z.object({
  url: z.string(),
  capacity: z.string().nullable(),
  zip: z.string().nullable(),
  controlledZip: z.string().nullable(),
  resultId: z.string().nullable(),
  availability: z.string().nullable(),
  resultVisible: z.boolean(),
  body: z.string(),
  counts: z.record(z.string(), z.number()),
});
type PageState = z.infer<typeof pageStateSchema>;

// This observer uses the launched browser's CDP directly, independently of
// Browser Harness resolution/actions. It never changes the page or app state.
const observePage = `(() => {
  const result = document.querySelector('#pickup-result');
  const zip = document.querySelector('#zip');
  const appState = document.querySelector('#react-state');
  const rect = result?.getBoundingClientRect();
  return {
    url: location.href,
    capacity: document.querySelector('input[name="pl_dimensionCapacity"]:checked')?.value ?? null,
    zip: zip?.value ?? null,
    controlledZip: appState ? JSON.parse(appState.textContent).zip ?? null : null,
    resultId: result?.getAttribute('data-result-id') ?? null,
    availability: result?.textContent?.trim() ?? null,
    resultVisible: !!(result && rect?.width && rect?.height && getComputedStyle(result).visibility !== 'hidden'),
    body: document.body.innerText,
    counts: window.fixture?.counts ?? {},
  };
})()`;

describe.sequential.each(matrix)("real $label browser element-action journey", (engine) => {
  it("finds pickup using shipped Opensteer guidance and checks the site's result", async () => {
    const startedAt = Date.now();
    const nonce = randomUUID();
    const outputRoot =
      process.env.OPENSTEER_ENGINE_E2E_OUTPUT ??
      path.join(tmpdir(), "opensteer-browser-actions-engines");
    const directory = path.resolve(
      outputRoot,
      `${new Date(startedAt).toISOString().replaceAll(":", "-")}-${engine.driverKind}-${nonce}`,
    );
    await mkdir(directory, { recursive: true });
    const previousCleanupDirectory = process.env.OPENSTEER_BROWSER_CLEANUP_E2E_ARTIFACT_DIR;
    process.env.OPENSTEER_BROWSER_CLEANUP_E2E_ARTIFACT_DIR = path.join(directory, "cleanup");
    addCleanup("restore cleanup evidence directory", async () => {
      if (previousCleanupDirectory === undefined)
        delete process.env.OPENSTEER_BROWSER_CLEANUP_E2E_ARTIFACT_DIR;
      else process.env.OPENSTEER_BROWSER_CLEANUP_E2E_ARTIFACT_DIR = previousCleanupDirectory;
    });
    const evidence: Record<string, unknown> = {
      outcome: "failed",
      driverKind: engine.driverKind,
      sourceId: engine.sourceId,
      accountMode: "ambient",
      executableMode: "shipped",
      nonce,
      startedAt: new Date(startedAt).toISOString(),
      guidance:
        "Shipped Opensteer guidance; all bundled skills supplied by startVerticalStack, without test-only filtering",
      rerun: `OPENSTEER_CHROMIUM_EXECUTABLE=${JSON.stringify(executablePath)} OPENSTEER_ENGINE_E2E_OUTPUT=${JSON.stringify(outputRoot)} OPENSTEER_PROFILE_ENGINE=${engine.driverKind} pnpm test:engines tests/browser-harness-actions.engine.test.ts`,
    };
    let stack: VerticalStack | undefined;
    let fixture: Awaited<ReturnType<typeof serveHarnessActionsFixture>> | undefined;
    const launched: LaunchedBrowser[] = [];
    let runId: RunId | undefined;
    let events: readonly AgentEvent[] = [];
    let reply = "";
    let pageState: PageState | undefined;
    let origin: string | undefined;
    let screenshotCount = 0;
    const diagnostics: unknown[] = [];
    const evidenceErrors: string[] = [];
    let journeyFailure: unknown;
    try {
      if (!process.env.OPENSTEER_TEST_DATABASE_URL)
        throw new Error("Run through pnpm test:engines; a database is required");
      if (!executablePath)
        throw new Error("A Chromium executable is required; set OPENSTEER_CHROMIUM_EXECUTABLE");
      Object.assign(evidence, {
        gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        gitStatus: execFileSync("git", ["status", "--short"], { encoding: "utf8" }),
        harnessModules: await moduleHashes(harnessRoot),
        skills: await Promise.all(
          (await readdir(skillRoot)).sort().map(async (name) => ({
            name,
            sha256: await sha256(path.join(skillRoot, name, "SKILL.md")),
          })),
        ),
        browserSkillSha256: await sha256(path.join(skillRoot, "opensteer-browser", "SKILL.md")),
      });
      const restorePath = await shippedEnginesFirstOnPath();
      addCleanup("shipped engine PATH wrappers", restorePath);
      evidence.cliVersion = await qualifiedVersion(engine);
      evidence.cliExecutable = parseAgentExecutionConfig(process.env).harnessExecutables[
        engine.driverKind
      ];
      fixture = await serveHarnessActionsFixture();
      addCleanup("shared pickup fixture", fixture.close);
      origin = fixture.origin;
      const url = `${fixture.url("engine")}?nonce=${nonce}`;
      evidence.fixture = { url, sha256: fixture.sha256 };
      const browser = await startBrowser({ onLaunch: (instance) => launched.push(instance) });
      // Registered before stack startup; the Browser Runtime must close while
      // the Host/vault are still present, even when catalog startup fails.
      addCleanup("engine journey Browser Runtime, then Host/Runner", async () => {
        try {
          await browser.close();
        } finally {
          await stack?.close();
        }
      });
      stack = await startVerticalStack({
        browser,
        browserHarnessExecutable: browserHarness,
        catalogTimeoutMs: 180_000,
        databaseUrl: process.env.OPENSTEER_TEST_DATABASE_URL,
        harnessInstance: qualificationAccount(engine),
        harnesses: createHarnessRegistry(
          parseAgentExecutionConfig(process.env).harnessExecutables,
          {
            nodeExecutable: process.execPath,
            runtimeCacheDirectory: path.join(tmpdir(), "opensteer-test-runtime-cache"),
          },
        ),
        harnessRuntimeBoundary: nativeUserHarnessRuntimeBoundary,
        runTimeoutMs: 600_000,
        runnerLogger: {
          info: (message, detail) => diagnostics.push({ level: "info", message, detail }),
          error: (message, detail) => diagnostics.push({ level: "error", message, detail }),
        },
      });
      await browserAvailable(stack);
      const model = stack.catalog.models.find((candidate) => candidate.isDefault);
      if (!model) throw new Error("The real engine did not admit a default catalog model");
      evidence.model = model;
      evidence.workspaceFilesBeforeRun = await readdir(stack.mountedWorkspacePath);
      const threadId = await stack.createThread({
        home: true,
        title: "Pickup availability",
        workspaceId: stack.mainWorkspaceId,
        modelSelection: ModelSelectionSchema.parse({
          modelId: model.modelId,
          providerId: model.providerId,
          options: {},
        }),
      });
      const prompt = `At ${url}, find pickup availability for the 512GB model in ZIP 10014. Select that capacity, submit the ZIP, and tell me the availability shown by the site. Use the shipped opensteer-browser skill.`;
      evidence.prompt = prompt;
      const runStartedAt = Date.now();
      const turn = await stack.sendMessage({
        text: prompt,
        threadId,
        workspaceId: stack.mainWorkspaceId,
        onQueued: (id) => {
          runId = id;
          return Promise.resolve();
        },
      });
      evidence.runDurationMs = Date.now() - runStartedAt;
      runId = turn.runId;
      events = turn.events;
      reply = turn.assistantText;
      expect(
        events.some((event) => event.type === "run.completed"),
        "the real Run completes without an execution error",
      ).toBe(true);
      const harnessCalls = analyseCalls(events).harnessCalls;
      expect(
        harnessCalls.length,
        "the agent actually invokes the shipped Browser Harness",
      ).toBeGreaterThan(0);
      const submissions = z
        .object({ submissions: z.array(submissionSchema) })
        .parse(fixture).submissions;
      evidence.serverSubmissions = submissions;
      expect(submissions, "one real server-side submission for this isolated journey").toHaveLength(
        1,
      );
      const submission = submissions[0]!;
      expect({
        nonce: submission.nonce,
        capacity: submission.capacity.toUpperCase(),
        zip: submission.zip,
        count: submission.count,
      }).toEqual({ nonce, capacity: "512GB", zip: "10014", count: 1 });
      const pages = launched
        .flatMap((instance) => instance.context.pages())
        .filter((page) => page.url().startsWith(`${origin}/`));
      expect(pages, "one fixture page left for the person").toHaveLength(1);
      const cdp = await pages[0]!.cdp();
      const state = await cdp.send("Runtime.evaluate", {
        expression: observePage,
        returnByValue: true,
      });
      pageState = pageStateSchema.parse(
        z.object({ result: z.object({ value: z.unknown() }) }).parse(state).result.value,
      );
      evidence.pageState = pageState;
      expect(pageState.capacity?.toUpperCase(), "the actual selected radio").toBe("512GB");
      expect(pageState.zip, "the DOM input").toBe("10014");
      expect(pageState.controlledZip, "React's controlled value").toBe("10014");
      expect(pageState.resultVisible, "the site's result is visible").toBe(true);
      expect(pageState.resultId, "the page shows the server-generated result identity").toBe(
        submission.resultId,
      );
      expect(pageState.availability).toContain(submission.availability);
      expect(pageState.body).toContain("512GB");
      expect(pageState.body).toContain("10014");
      expect(
        reply.toLowerCase(),
        "the final reply agrees with the server's availability",
      ).toContain(submission.availability.toLowerCase());
      evidence.outcome = "passed";
    } catch (error) {
      evidence.failure =
        error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
      journeyFailure = error;
    } finally {
      // Persist partial real transcripts even if sendMessage throws on a failed
      // Run. Never export Runner private state, auth files or environment maps.
      if (stack && runId) {
        try {
          const durable: AgentEvent[] = [];
          let cursor = zeroSequence;
          for (;;) {
            const batch = await stack.host.store.eventsAfter(stack.mainWorkspaceId, cursor);
            if (!batch.length) break;
            durable.push(...batch.filter((event) => event.runId === runId));
            cursor = batch.at(-1)!.sequence;
          }
          events = durable;
        } catch (error) {
          evidenceErrors.push(`Transcript: ${String(error)}`);
        }
      }
      if (fixture) {
        evidence.fixtureRequests = fixture.requests;
        const submissions = z.object({ submissions: z.array(submissionSchema) }).safeParse(fixture);
        if (submissions.success) evidence.serverSubmissions = submissions.data.submissions;
      }
      const screenshots: string[] = [];
      for (const instance of launched) {
        try {
          evidence.browserVersion = await instance.cdp.send("Browser.getVersion");
        } catch (error) {
          evidenceErrors.push(`Browser version: ${String(error)}`);
        }
        for (const page of instance.context.pages()) {
          if (!origin || !page.url().startsWith(`${origin}/`)) continue;
          try {
            const cdp = await page.cdp();
            if (!pageState) {
              const state = await cdp.send("Runtime.evaluate", {
                expression: observePage,
                returnByValue: true,
              });
              evidence.pageState = z
                .object({ result: z.object({ value: z.unknown() }) })
                .parse(state).result.value;
            }
            const { data } = z.object({ data: z.string() }).parse(
              await cdp.send("Page.captureScreenshot", {
                format: "png",
                captureBeyondViewport: false,
              }),
            );
            const screenshot = path.join(directory, `page-${++screenshotCount}.png`);
            await writeFile(screenshot, Buffer.from(data, "base64"));
            screenshots.push(screenshot);
          } catch (error) {
            evidenceErrors.push(`Page evidence: ${String(error)}`);
          }
        }
      }
      try {
        const finalModules = await moduleHashes(harnessRoot);
        const finalSkill = await sha256(path.join(skillRoot, "opensteer-browser", "SKILL.md"));
        evidence.harnessModulesAfterRun = finalModules;
        evidence.browserSkillSha256AfterRun = finalSkill;
        if (
          JSON.stringify(evidence.harnessModules) !== JSON.stringify(finalModules) ||
          evidence.browserSkillSha256 !== finalSkill
        ) {
          evidenceErrors.push(
            "Harness modules or shipped browser guidance changed during the journey",
          );
        }
      } catch (error) {
        evidenceErrors.push(`Module evidence: ${String(error)}`);
      }
      Object.assign(evidence, {
        runId,
        reply,
        events,
        analysis: analyseCalls(events, evidence.serverSubmissions),
        diagnostics,
        screenshots,
        durationMs: Date.now() - startedAt,
        evidenceErrors,
        cleanupEvidenceDirectory: path.join(directory, "cleanup"),
      });
      if (
        evidence.outcome === "passed" &&
        (screenshots.length === 0 || evidenceErrors.length > 0)
      ) {
        evidence.outcome = "failed";
        evidence.failure = "Required screenshot/transcript evidence could not be captured";
      }
      await writeFile(
        path.join(directory, "result.json"),
        `${JSON.stringify(scrubEvidence(evidence), null, 2)}\n`,
      );
      process.stdout.write(`real ${engine.driverKind} browser journey evidence: ${directory}\n`);
    }
    if (journeyFailure) throw journeyFailure;
    expect(evidence.outcome, "required screenshot/transcript evidence captured").toBe("passed");
  });
});

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function moduleHashes(directory: string) {
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".mjs"))
      .sort()
      .map(async (name) => ({ name, sha256: await sha256(path.join(directory, name)) })),
  );
}

function analyseCalls(events: readonly AgentEvent[], serverSubmissions?: unknown) {
  const completions = new Map(
    events
      .filter((event) => event.type === "tool.completed")
      .map((event) => [event.data.callId, event]),
  );
  const calls = events
    .filter((event) => event.type === "tool.started")
    .map((event) => {
      const script = JSON.stringify(event.data.arguments);
      const completion = completions.get(event.data.callId);
      return {
        callId: event.data.callId,
        startedAt: event.createdAt,
        completedAt: completion?.createdAt,
        tool: event.data.tool,
        arguments: event.data.arguments,
        output: completion?.data.output,
        isError: completion?.data.isError ?? null,
        harness: /OPENSTEER_BROWSER_HARNESS|browser-harness(?:\.mjs)?/u.test(script),
        locators: /\.(?:getByRole|getByLabel|getByText|locator)\s*\(/u.test(script),
        coordinates: /\bclickAt\s*\(|\.mouse\.click\s*\(/u.test(script),
        verificationRead:
          /ariaSnapshot|isChecked|inputValue|waitForURL|waitForFunction|captureScreenshot|\.screenshot|\.evaluate|\bjs\s*\(/u.test(
            script,
          ),
      };
    });
  const harnessCalls = calls.filter((call) => call.harness);
  const errors = harnessCalls.filter(
    (call) =>
      call.isError ||
      /(?:Error:|outcome unknown|timed? ?out|strict mode violation)/iu.test(
        call.output?.text ?? "",
      ),
  );
  const submissions = z.array(submissionSchema).safeParse(serverSubmissions);
  const result = submissions.success ? submissions.data.at(-1) : undefined;
  const verificationCalls = harnessCalls.filter((call) => {
    const output = call.output?.text ?? "";
    return (
      call.isError === false &&
      result !== undefined &&
      (output.includes(result.resultId) ||
        output.toLowerCase().includes(result.availability.toLowerCase()))
    );
  });
  return {
    method:
      "Heuristic call classification; preserved arguments/results are authoritative. Verification reads are candidates for transcript review, not a pass condition.",
    harnessCalls,
    verifiedOutcomeBeforeAnswer: {
      assessment:
        verificationCalls.length > 0
          ? "observed"
          : "not established by text output; inspect transcript/screenshots",
      evidenceCallIds: verificationCalls.map((call) => call.callId),
      criterion:
        "A completed harness call returned the server-generated result identity or availability before the Run ended",
    },
    locatorCallIds: calls.filter((call) => call.locators).map((call) => call.callId),
    coordinateCallIds: calls.filter((call) => call.coordinates).map((call) => call.callId),
    verificationReadCallIds: calls
      .filter((call) => call.verificationRead)
      .map((call) => call.callId),
    harnessErrors: errors.map((call) => ({
      callId: call.callId,
      output: call.output,
      laterSuccessfulHarnessCallIds: harnessCalls
        .slice(harnessCalls.indexOf(call) + 1)
        .filter((later) => later.isError === false)
        .map((later) => later.callId),
    })),
  };
}

function scrubEvidence(value: unknown): unknown {
  const secrets = Object.entries(process.env)
    .filter(
      ([key, content]) => content && /(?:TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL)$/u.test(key),
    )
    .map(([, content]) => content!)
    .sort((a, b) => b.length - a.length);
  const scrub = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
      return text
        .replace(/Bearer\s+[^\s"'\\]+/giu, "Bearer [redacted]")
        .replace(/([?&](?:token|access_token|secret)=)[^\s"'&]+/giu, "$1[redacted]");
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [
          key,
          /^(?:authorization|cookie|set-cookie|accessToken|refreshToken|bridgeToken|sessionCookie|apiKey|password)$/iu.test(
            key,
          )
            ? "[redacted]"
            : scrub(entry),
        ]),
      );
    return item;
  };
  return scrub(value);
}
