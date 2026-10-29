import type { CdpParameters } from "@opensteer/browser-core";
import { sendAsAgent } from "./browser-harness.test-support.js";
import { describe, expect } from "vitest";
import { z } from "zod";
import {
  acceptance,
  traceSettled,
  expectGroupsReleasedBeforeDetach,
} from "./harness-actions.test-support.js";

describe("Browser Harness element actions / real hosted Chromium", () => {
  acceptance(
    "15-released-handles",
    "an operation's object group is released and its handles stop resolving",
    async (kit, report) => {
      let handle: { objectId: unknown; sessionId?: string | undefined } | undefined;
      let control: string | undefined;
      let probed: string | undefined;
      const agent = (method: string, parameters: CdpParameters, sessionId?: string) =>
        sendAsAgent(
          (message) => kit.controller.handle(message),
          kit.sink.messages,
          method,
          parameters,
          sessionId,
        );
      kit.hooks.before = async (method, _parameters, sessionId) => {
        if (method !== "Target.detachFromTarget" || probed !== undefined) return;
        const used = kit.trace.find(
          (e) =>
            e.method === "Runtime.callFunctionOn" &&
            typeof e.parameters?.objectGroup === "string" &&
            e.parameters.objectGroup.startsWith("opensteer-op-"),
        );
        handle = { objectId: used?.parameters?.objectId, sessionId: used?.sessionId ?? sessionId };
        // A fresh object on the same live session must still resolve, so a failing
        // probe below means the handle was released, not that the session is gone.
        const fresh = await agent(
          "Runtime.evaluate",
          { expression: "document", objectGroup: "released-handles-control" },
          handle.sessionId,
        );
        control = await agent(
          "Runtime.callFunctionOn",
          {
            objectId: (fresh as { result: { objectId: string } }).result.objectId,
            functionDeclaration: "function() { return 1; }",
            returnByValue: true,
          },
          handle.sessionId,
        ).then(
          () => "resolved",
          (error: unknown) => String(error),
        );
        await agent(
          "Runtime.releaseObjectGroup",
          { objectGroup: "released-handles-control" },
          handle.sessionId,
        );
        probed = await agent(
          "Runtime.callFunctionOn",
          {
            objectId: handle.objectId as string,
            functionDeclaration: "function() { return 1; }",
            returnByValue: true,
          },
          handle.sessionId,
        ).then(
          () => "resolved",
          (error: unknown) => String(error),
        );
      };
      await kit.run(`await page.getByRole('button',{name:'Still usable'}).click();`);
      report.probe = { handle, control, probed };
      expect(typeof handle?.objectId).toBe("string");
      expect(control).toBe("resolved");
      expect(probed).toBeDefined();
      expect(probed).not.toBe("resolved");
      expect(
        kit.trace.some(
          (e) =>
            e.method === "Runtime.releaseObjectGroup" &&
            e.finished !== undefined &&
            e.error === undefined,
        ),
      ).toBe(true);
    },
    "12",
  );

  acceptance(
    "15-failed-op-release",
    "a program ending on a failed action still has its object group released before it detaches",
    async (kit) => {
      let delayed = 0;
      kit.hooks.before = async (method) => {
        if (method !== "Runtime.releaseObjectGroup") return;
        delayed++;
        await new Promise((resolve) => setTimeout(resolve, 500));
      };
      // Each program ends on an action whose group release is not awaited inline:
      // one past its deadline, one interrupted by a dialog the program answers.
      await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:300}),/element was not found/);`,
      );
      await kit.navigate(kit.site.url("13"));
      await kit.run(
        `await fails(()=>page.locator('#click').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});`,
      );
      expect(delayed).toBeGreaterThan(0);
      const detaches = kit.trace.filter((e) => e.method === "Target.detachFromTarget");
      const groups = new Set(
        kit.trace.flatMap((e) =>
          typeof e.parameters?.objectGroup === "string" &&
          e.parameters.objectGroup.startsWith("opensteer-op-")
            ? [JSON.stringify([e.sessionId, e.parameters.objectGroup])]
            : [],
        ),
      );
      expect(groups.size).toBeGreaterThan(0);
      for (const group of groups) {
        const release = kit.trace.find(
          (e) =>
            e.method === "Runtime.releaseObjectGroup" &&
            JSON.stringify([e.sessionId, e.parameters?.objectGroup]) === group,
        );
        expect(release, group).toBeDefined();
        expect(release!.error, group).toBeUndefined();
        expect(release!.finished, group).toBeDefined();
        const detach = detaches.find((e) => e.at > release!.at);
        expect(release!.finished!, group).toBeLessThanOrEqual(detach!.at);
      }
    },
    "12",
  );

  acceptance(
    "15-slow-release",
    "a release slower than the grace on a page that still answers is awaited before the session detaches",
    async (kit) => {
      let delayed = 0;
      kit.hooks.before = async (method) => {
        if (method !== "Runtime.releaseObjectGroup") return;
        delayed++;
        await new Promise((resolve) => setTimeout(resolve, 2500));
      };
      // Each program ends on an action whose group release is not awaited inline:
      // one past its deadline, one interrupted by a dialog the program answers.
      await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:300}),/element was not found/);`,
      );
      await kit.navigate(kit.site.url("13"));
      await kit.run(
        `await fails(()=>page.locator('#click').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});`,
      );
      // Replaying buffered events must not make the answered dialog look open again.
      await kit.run(
        `await fails(()=>page.locator('#click').click(),/dialog/i);await cdp('Page.handleJavaScriptDialog',{accept:true});drainEvents();`,
      );
      expect(delayed).toBeGreaterThan(0);
      const detaches = kit.trace.filter((e) => e.method === "Target.detachFromTarget");
      const groups = new Set(
        kit.trace.flatMap((e) =>
          typeof e.parameters?.objectGroup === "string" &&
          e.parameters.objectGroup.startsWith("opensteer-op-")
            ? [JSON.stringify([e.sessionId, e.parameters.objectGroup])]
            : [],
        ),
      );
      expect(groups.size).toBeGreaterThan(0);
      for (const group of groups) {
        const release = kit.trace.find(
          (e) =>
            e.method === "Runtime.releaseObjectGroup" &&
            JSON.stringify([e.sessionId, e.parameters?.objectGroup]) === group,
        );
        expect(release, group).toBeDefined();
        expect(release!.error, group).toBeUndefined();
        expect(release!.finished, group).toBeDefined();
        const detach = detaches.find((e) => e.at > release!.at);
        expect(release!.finished!, group).toBeLessThanOrEqual(detach!.at);
      }
    },
    "12",
  );

  acceptance(
    "15-stalled-move",
    "an action whose pointer move went unanswered leaves promptly without awaiting its group release",
    async (kit, report) => {
      kit.hooks.before = async (method, parameters) => {
        // Unanswered for longer than the release grace past the deadline: a stalled page.
        if (method === "Input.dispatchMouseEvent" && parameters?.type === "mouseMoved")
          await new Promise((resolve) => setTimeout(resolve, 4000));
        if (method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, 5000));
      };
      const out = await kit.run(
        `await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:500}),/Timeout/);`,
        { timeoutMs: 15_000 },
      );
      report.processElapsed = out.elapsedMs;
      // The page stopped answering inside the action, so leaving does not wait again.
      expect(out.elapsedMs).toBeLessThan(500 + 2000 + 1500);
      expect(
        kit.trace.filter(
          (e) => e.method === "Input.dispatchMouseEvent" && e.parameters?.type === "mousePressed",
        ),
      ).toHaveLength(0);
    },
    "12",
  );

  acceptance(
    "15-early-timer",
    "a settlement timer that wakes before its cutoff looks again, so a reply just before the cutoff keeps the release awaited",
    async (kit, report) => {
      // Wall-clock times from the harness's own stderr and from the bridge.
      let actionStart: number | undefined;
      let earlyWake: number | undefined;
      let moveReplySent: number | undefined;
      let started!: () => void;
      const actionStarted = new Promise<void>((resolve) => (started = resolve));
      kit.hooks.before = async (method, parameters) => {
        // The action's 500 ms deadline and 2 s grace put its cutoff at least
        // 2.5 s after its start. This reply goes out 500 ms before that.
        if (method === "Input.dispatchMouseEvent" && parameters?.type === "mouseMoved") {
          await actionStarted;
          await new Promise((resolve) => setTimeout(resolve, actionStart! + 2000 - Date.now()));
          moveReplySent = Date.now();
        }
        if (method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, 3500));
      };
      // After its action the program makes long timers wake a second early,
      // as an event loop may, and says when one does.
      const out = await kit.run(
        `process.stderr.write('[test] action-start '+Date.now()+'\\n');
await fails(()=>page.getByRole('button',{name:'Still usable'}).click({timeout:500}),/Timeout/);
const realSetTimeout=globalThis.setTimeout;
globalThis.setTimeout=(callback,ms,...rest)=>ms>=1500
  ?realSetTimeout(()=>{process.stderr.write('[test] early-wake '+Date.now()+'\\n');callback();},ms-1000,...rest)
  :realSetTimeout(callback,ms,...rest);`,
        {
          timeoutMs: 15_000,
          onStderrLine: (line) => {
            const [, kind, at] = /^\[test\] (action-start|early-wake) (\d+)$/u.exec(line) ?? [];
            if (kind === "action-start") {
              actionStart = Number(at);
              started();
            }
            if (kind === "early-wake") earlyWake ??= Number(at);
          },
        },
      );
      await traceSettled(kit);
      const cutoff = actionStart! + 500 + 2000;
      report.timing = { actionStart, earlyWake, moveReplySent, cutoff, exit: out.elapsedMs };
      // Preconditions: a settlement timer woke while the move was still
      // unanswered and well before the cutoff, and the reply went out early
      // enough to reach the harness before the cutoff.
      expect(actionStart).toBeDefined();
      expect(earlyWake).toBeDefined();
      expect(moveReplySent).toBeDefined();
      expect(earlyWake!).toBeLessThan(moveReplySent!);
      expect(earlyWake!).toBeLessThan(cutoff - 500);
      expect(moveReplySent!).toBeLessThan(cutoff - 300);
      report.groups = expectGroupsReleasedBeforeDetach(kit);
    },
    "12",
  );

  acceptance(
    "15-release-outlives-action",
    "a release still pending when an action that ended early reaches its deadline is awaited before detach",
    async (kit, report) => {
      kit.hooks.before = async (method) => {
        if (method === "Runtime.releaseObjectGroup")
          await new Promise((resolve) => setTimeout(resolve, 4000));
      };
      const out = await kit.run(
        `console.log(JSON.stringify({operationStart:Date.now()}));
await fails(()=>page.locator('.duplicate').click({timeout:3000}),/Strict mode violation/);`,
        { timeoutMs: 15_000 },
      );
      await traceSettled(kit);
      // The action's 3 s deadline starts after this harness-local reading, so
      // the budget computed from it is a lower bound, whatever binding took.
      const { operationStart } = z
        .object({ operationStart: z.number() })
        .parse(JSON.parse(out.stdout.trim().split("\n")[0]!));
      const release = kit.trace.find((e) => e.method === "Runtime.releaseObjectGroup")!;
      const wall = (at: number) => performance.timeOrigin + at;
      report.budgetLeftAtRelease = operationStart + 3000 - wall(release.at);
      report.releaseFinishedAfterDeadline = wall(release.finished!) - (operationStart + 3000);
      // Preconditions: the release was sent with most of the budget left and
      // stayed pending past the deadline.
      expect(report.budgetLeftAtRelease).toBeGreaterThanOrEqual(2500);
      expect(report.releaseFinishedAfterDeadline).toBeGreaterThan(0);
      report.groups = expectGroupsReleasedBeforeDetach(kit);
    },
    "02",
  );

  for (const round of [1, 2, 3])
    acceptance(
      `15-deadline-soak-${round}`,
      "a 300 ms missing-element action, repeated, always has its slow release awaited",
      async (kit, report) => {
        kit.hooks.before = async (method) => {
          if (method === "Runtime.releaseObjectGroup")
            await new Promise((resolve) => setTimeout(resolve, 2500));
        };
        for (let iteration = 0; iteration < 5; iteration++)
          await kit.run(
            `await fails(()=>page.getByRole('button',{name:'Missing action'}).click({timeout:300}),/element was not found/);`,
          );
        report.groups = expectGroupsReleasedBeforeDetach(kit);
      },
      "12",
    );
});
