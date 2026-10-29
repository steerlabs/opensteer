// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request } from "@opensteer/core";
import type { ChromeConnectEnvironment } from "./chrome/chrome-environment.js";
import {
  BrowserSignInRequestBody,
  type BrowserSignInRequestClient,
} from "./thread-browser-sign-in-action.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/*
 * How the card could sign in with a Chrome the person did not choose, or keep
 * re-sending on its own:
 * - the allowed Chrome reports a problem while another reads signed in, and
 *   the card allows the other one;
 * - the allowed Chrome keeps reading signed in although its export failed, and
 *   every inspection re-sends;
 * - the site is removed from the Workspace after the Allow, and a retry adds
 *   it back;
 * - the problem is one no inspection can clear (the browser is too old), and
 *   the card retries whenever Chrome reads signed in.
 * The one retry it may make: the allowed Chrome turning signed in, once.
 */

const site = "https://github.com";
const workspaceId = "wsp_00000000-0000-4000-8000-000000000003";
const macId = "bsr_00000000-0000-4000-8000-000000000001";
const workId = "bsr_00000000-0000-4000-8000-000000000002";
type Status = "available" | "stopped" | "offline";

let root: Root | null = null;
let container: HTMLElement | null = null;
let statuses: Record<string, Status>;
let grantSource: string | null;
let outcomes: object[];
let dispatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  grantSource = macId;
  outcomes = [];
  dispatch = vi.fn(async () => ({
    outcome: outcomes.shift() ?? {
      profileName: null,
      site,
      sourceName: "Chrome on Mac",
      status: "applied",
    },
    type: "browser.sign-in.respond",
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("BrowserSignInRequestBody after Allow", () => {
  it("never allows another Chrome and never repeats a failed Allow on its own", async () => {
    statuses = { [macId]: "available", [workId]: "available" };
    outcomes = [problem("stopped")];
    await render();
    await click("Chrome on Mac");
    await click("Allow");
    expect(allowedSources()).toEqual([macId]);

    // Chrome on Mac still reads signed in; Work Chrome too. Nothing is re-sent.
    await tick(3);
    expect(allowedSources()).toEqual([macId]);

    // Chrome on Mac now reads stopped while Work Chrome is signed in: still nothing.
    statuses = { [macId]: "stopped", [workId]: "available" };
    await tick(3);
    expect(allowedSources()).toEqual([macId]);
    expect(text()).toContain("Sharing github.com is stopped in Chrome on Mac");
    expect(text()).toContain("finishes by itself once that’s fixed");
  });

  it("retries the allowed Chrome once, when it turns signed in", async () => {
    statuses = { [macId]: "available", [workId]: "offline" };
    outcomes = [problem("stopped")];
    await render();
    await click("Allow");
    expect(allowedSources()).toEqual([macId]);

    statuses = { ...statuses, [macId]: "stopped" };
    await tick(2);
    expect(allowedSources()).toEqual([macId]);

    statuses = { ...statuses, [macId]: "available" };
    await tick(1);
    expect(allowedSources()).toEqual([macId, macId]);
    expect(text()).toContain("Signed in to github.com.");

    await tick(3);
    expect(allowedSources()).toHaveLength(2);
  });

  it("does not retry once the site was removed from the Workspace", async () => {
    statuses = { [macId]: "available", [workId]: "offline" };
    outcomes = [problem("stopped")];
    await render();
    await click("Allow");
    statuses = { ...statuses, [macId]: "stopped" };
    await tick(1);

    grantSource = null;
    statuses = { ...statuses, [macId]: "available" };
    await tick(3);
    expect(allowedSources()).toEqual([macId]);
    expect(text()).toContain("Choose Try again once that’s fixed.");

    await click("Try again");
    expect(allowedSources()).toEqual([macId, macId]);
  });

  it("leaves a problem no inspection can clear to the person", async () => {
    statuses = { [macId]: "available", [workId]: "offline" };
    outcomes = [problem("runtime-outdated")];
    await render();
    await click("Allow");
    statuses = { ...statuses, [macId]: "stopped" };
    await tick(1);
    statuses = { ...statuses, [macId]: "available" };
    await tick(3);
    expect(allowedSources()).toEqual([macId]);
    expect(text()).toContain("This browser can’t take a Chrome sign-in yet");

    await click("Try again");
    expect(allowedSources()).toEqual([macId, macId]);
  });
});

function problem(name: string) {
  return { problem: name, site, sourceName: "Chrome on Mac", status: "problem" };
}

async function render(): Promise<void> {
  const client = {
    dispatch,
    rpc: {
      "browser.sources.get": vi.fn(async () => ({
        data: {
          sites: grantSource
            ? [
                {
                  createdAt: "2026-09-18T12:00:00.000Z",
                  lastSignedInAt: null,
                  preferredSourceId: grantSource,
                  site,
                  workspaceId,
                },
              ]
            : [],
          sources: [],
        },
        ok: true,
      })),
      "browser.sources.inspect": vi.fn(async () => ({
        data: {
          candidates: [
            { name: "Chrome on Mac", sourceId: macId, status: statuses[macId] },
            { name: "Work Chrome", sourceId: workId, status: statuses[workId] },
          ],
          site,
        },
        ok: true,
      })),
    },
  } as unknown as BrowserSignInRequestClient;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <BrowserSignInRequestBody
        client={client}
        disabled={false}
        environment={{} as ChromeConnectEnvironment}
        profileName={null}
        request={signInRequest()}
        workspaceName="Research"
      />,
    ),
  );
  await settle();
}

function allowedSources(): (string | undefined)[] {
  return dispatch.mock.calls.map(
    ([command]) => (command as { decision: { sourceId?: string } }).decision.sourceId,
  );
}

async function tick(times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await act(async () => vi.advanceTimersByTime(4_000));
    await settle();
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await act(async () => undefined);
}

async function click(label: string): Promise<void> {
  const target = [...(container?.querySelectorAll("button, label") ?? [])].find((element) =>
    element.textContent?.includes(label),
  );
  if (!target) throw new Error(`No control named ${label}: ${text()}`);
  const input = target.querySelector("input");
  await act(async () => (input ?? (target as HTMLElement)).click());
  await settle();
}

function text(): string {
  return container?.textContent ?? "";
}

function signInRequest(): Request {
  return {
    callId: "call-1",
    cancellationReason: null,
    createdAt: "2026-09-18T12:00:00.000Z",
    id: "req_00000000-0000-4000-8000-000000000004",
    kind: "browser.sign-in",
    mode: "durable",
    originatingOccurrenceId: null,
    originatingRunId: null,
    originatingThreadId: null,
    originatingWorkspaceId: workspaceId,
    payload: {
      kind: "browser.sign-in",
      reason: "Open the pull request",
      sessionId: "bss_1",
      site,
    },
    presentation: {
      kind: "external",
      subject: { id: site, kind: "browser-site" },
      title: "Sign in to github.com",
    },
    requestedBy: "usr_00000000-0000-4000-8000-000000000001",
    requiredActor: "workspace-owner",
    resolvedAt: null,
    resolvedBy: null,
    response: null,
    status: "pending",
    targetWorkspaceId: workspaceId,
  } as unknown as Request;
}
