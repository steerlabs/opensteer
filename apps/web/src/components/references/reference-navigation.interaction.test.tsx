// @vitest-environment happy-dom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createId, type ReferenceId } from "@opensteer/core";
import type { ReferenceResolveInput, ReferenceResolveResult } from "@opensteer/protocol";
import { TranscriptFileController, type HostClient } from "@opensteer/client/host";
import { MockHostClient } from "@opensteer/client/mock";
import { ReferenceStore } from "@opensteer/client/references";
import {
  MockTeamHost,
  TeamSessionClient,
  createMemoryTeamPersistence,
} from "@opensteer/client/team";
import { TeamsProvider } from "../../team/team-attachments.js";
import { Markdown } from "../markdown.js";
import { MessageBody } from "../team/message-body.js";
import { ToastProvider } from "../toast.js";
import type { WorkspaceNavigation } from "../workspace/navigation.js";
import { WorkspaceProvider } from "../workspace/workspace-context.js";
import { PersonalReferences, TeamReferences } from "./reference-scope.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/** Chips ask the Host only once on screen; the test says when they are. */
const observed = new Set<{ callback: IntersectionObserverCallback; element: Element }>();
function scrollIntoView() {
  for (const { callback, element } of observed)
    callback(
      [{ isIntersecting: true, target: element } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    );
}
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      readonly #callback: IntersectionObserverCallback;
      readonly #held: { callback: IntersectionObserverCallback; element: Element }[] = [];
      constructor(callback: IntersectionObserverCallback) {
        this.#callback = callback;
      }
      observe(element: Element) {
        const entry = { callback: this.#callback, element };
        this.#held.push(entry);
        observed.add(entry);
      }
      disconnect() {
        for (const entry of this.#held) observed.delete(entry);
      }
    },
  );
});

const roots: Root[] = [];
const clients: { dispose(): void }[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  for (const client of clients.splice(0)) client.dispose();
  observed.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function Where() {
  const { pathname, search } = useLocation();
  return <output data-where="">{pathname + search}</output>;
}

/** A personal transcript on its real router, with the workspace's own address rules. */
function mountPersonal(client: HostClient, threadId: string, words: ReactNode) {
  const showLauncher = vi.fn();
  // Bound once the router exists; the workspace only calls it on a press.
  let router: ReturnType<typeof createMemoryRouter> | null = null;
  const nav = {
    showLauncher,
    conversationHref: (to: string) => to,
    openPage: (to: string) => void router!.navigate(to),
    openConversation: (path: string, options?: { readonly messageId?: string }) => {
      const [pathname = path, query = ""] = path.split("?", 2);
      const params = new URLSearchParams(query);
      if (options?.messageId) params.set("messageId", options.messageId);
      void router!.navigate(params.size ? `${pathname}?${params}` : pathname);
    },
  } as unknown as WorkspaceNavigation;
  router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <WorkspaceProvider attention={0} nav={nav} openDrawer={() => undefined}>
            <ToastProvider>
              <PersonalReferences client={client} threadId={threadId}>
                {words}
              </PersonalReferences>
              <Where />
            </ToastProvider>
          </WorkspaceProvider>
        ),
      },
    ],
    { initialEntries: [`/tasks/${threadId}`] },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<RouterProvider router={router} />));
  return { container, showLauncher };
}

function chip(container: ParentNode, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>(".ref-chip")].find((element) =>
    element.textContent?.startsWith(label),
  );
  if (!found) throw new Error(`No chip labelled ${label}`);
  return found;
}

const where = (container: HTMLElement) =>
  container.querySelector("[data-where]")?.textContent ?? "";

it("opens unloaded targets at their parent, keeps the gone visibly gone, and retries a failed lookup", async () => {
  const threadId = createId("thread");
  const runId = createId("run");
  const anchorMessageId = createId("message");
  const goneId = createId("message");
  const requestId = createId("request");
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  await client.load();
  let requestLookups = 0;
  const resolve = vi.fn(
    async ({ ids }: ReferenceResolveInput): Promise<ReferenceResolveResult> => ({
      results: ids.map((id) => {
        if (id === runId)
          return {
            status: "available",
            kind: "run",
            id,
            threadId,
            anchorMessageId,
            title: "Deploy preview",
          } as const;
        if (id === requestId) {
          if (++requestLookups === 1) throw new TypeError("Failed to fetch");
          return {
            status: "available",
            kind: "request",
            id,
            threadId,
            requestStatus: "fulfilled",
            title: "Allow the deploy",
          } as const;
        }
        return { status: "unavailable", id: id as ReferenceId };
      }),
    }),
  );
  const references = new ReferenceStore({
    resolveReferences: resolve,
    getSnapshot: () => client.getSnapshot(),
    subscribe: (listener) => client.subscribe(listener),
  });
  clients.push(references);
  Object.defineProperty(client, "references", { value: references });
  const { container, showLauncher } = mountPersonal(
    client,
    threadId,
    <Markdown
      text={`See [the run](opensteer:${runId}), [old note](opensteer:${goneId}) and [the ask](opensteer:${requestId}).`}
    />,
  );
  // Nothing is on screen yet, so nothing is looked up.
  await act(async () => undefined);
  expect(resolve).not.toHaveBeenCalled();

  await act(async () => chip(container, "the run").click());
  await vi.waitFor(() => expect(where(container)).toContain(`/tasks/${threadId}?`), {
    timeout: 1000,
  });
  const opened = new URL(where(container), "https://app.test");
  expect(opened.searchParams.get("runId")).toBe(runId);
  expect(opened.searchParams.get("messageId")).toBe(anchorMessageId);

  // The request's first lookup fails: the chip stays a link and says so.
  await act(async () => chip(container, "the ask").click());
  await vi.waitFor(
    () => expect(document.body.textContent).toContain("Couldn't open this. Try again."),
    { timeout: 1000 },
  );
  expect(chip(container, "the ask").getAttribute("data-reference-state")).toBe("failed");
  await act(async () => chip(container, "the ask").click());
  await vi.waitFor(
    () => expect(where(container)).toBe(`/tasks/${threadId}?requestId=${requestId}`),
    {
      timeout: 1000,
    },
  );

  // On screen, the one the Host no longer has turns visibly unavailable and opens nothing.
  await act(async () => scrollIntoView());
  await vi.waitFor(
    () =>
      expect(chip(container, "old note").classList.contains("ref-chip--unavailable")).toBe(true),
    { timeout: 1000 },
  );
  const gone = chip(container, "old note");
  expect(gone.tagName).toBe("SPAN");
  expect(gone.getAttribute("aria-disabled")).toBe("true");
  expect(gone.title).toBe("No longer available");
  await act(async () => gone.click());
  expect(where(container)).toBe(`/tasks/${threadId}?requestId=${requestId}`);
  // The resolved run shows its current title.
  expect(chip(container, "Deploy preview")).toBeTruthy();
  // Nothing internal ever became a browsing tab.
  expect(showLauncher).not.toHaveBeenCalled();
});

it("opens a team page in the matching team session, and another team's at its own address", async () => {
  const host = new MockTeamHost();
  const session = new TeamSessionClient({
    scope: { teamDeploymentId: host.teamId, userId: host.userId },
    rpc: host.rpc,
    connect: host.connect,
    persistence: createMemoryTeamPersistence(),
  });
  clients.push(session, host);
  const attachment = {
    teamId: host.teamId,
    name: "Team",
    origin: host.origin,
    client: session,
    link: null,
  };
  const channelId = createId("teamChannel");
  const elsewhere = `https://other.example/c/${createId("teamChannel")}`;
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: (
          <TeamsProvider surface={{ kind: "team-web", attachment }}>
            <TeamReferences team={attachment}>
              <MessageBody
                mentions={[]}
                text={`[#launch](${host.origin}/c/${channelId}) [#ops](${elsewhere}) [my task](opensteer:${createId("thread")})`}
              />
            </TeamReferences>
            <Where />
          </TeamsProvider>
        ),
      },
    ],
    { initialEntries: ["/teams/start"] },
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<RouterProvider router={router} />));

  // A personal reference quoted in a team reads as its words only.
  expect(container.textContent).toContain("my task");
  expect([...container.querySelectorAll("a")].some((a) => a.textContent === "my task")).toBe(false);

  const other = chip(container, "#ops") as HTMLAnchorElement;
  expect(other.href).toBe(elsewhere);
  expect(other.target).toBe("_blank");
  expect(other.rel).toContain("noopener");
  const outward = new MouseEvent("click", { bubbles: true, cancelable: true });
  let kept = false;
  document.addEventListener(
    "click",
    (event) => {
      kept = !event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  act(() => void other.dispatchEvent(outward));
  expect(kept).toBe(true);
  expect(where(container)).toBe("/teams/start");

  await act(async () => chip(container, "#launch").click());
  expect(where(container)).toBe(`/teams/${host.teamId}/c/${channelId}`);
});

it("opens a file at its line, and says when a file isn't available", async () => {
  const threadId = createId("thread");
  const client = new MockHostClient({ latencyMs: 0 });
  clients.push(client);
  const text = Array.from({ length: 400 }, (_, index) => `const line${index + 1} = ${index};`).join(
    "\n",
  );
  const openFile = vi.fn(async ({ source }: { source: { kind: string; path?: string } }) =>
    source.kind === "path" && source.path === "/Users/me/Opensteer/src/http.ts"
      ? {
          status: "ok" as const,
          resource: { kind: "home" as const, key: "src/http.ts", revision: "r1" },
          name: "http.ts",
          sizeBytes: text.length,
          mediaType: "text/plain",
          preview: { kind: "text" as const, text, truncated: false },
        }
      : { status: "unavailable" as const },
  );
  const files = new TranscriptFileController({
    rpc: { openFile, readFile: () => Promise.reject(new Error("unused")) },
  });
  clients.push(files);
  Object.defineProperty(client, "transcriptFiles", { value: files });
  const { container, showLauncher } = mountPersonal(
    client,
    threadId,
    <Markdown
      text={
        "Changed [http.ts:42](/Users/me/Opensteer/src/http.ts:42) and " +
        "[gone.ts](/Users/me/Opensteer/gone.ts)."
      }
    />,
  );
  const http = chip(container, "http.ts");
  expect(http.querySelector(".ref-chip__position")?.textContent).toBe(":42");
  http.focus();
  await act(async () => http.click());
  const target = await vi.waitFor(
    () => {
      const line = document.querySelector<HTMLElement>('.file-viewer [data-line="42"]');
      if (!line) throw new Error("Line 42 never drew");
      return line;
    },
    { timeout: 1000 },
  );
  expect(target.classList.contains("file-line--target")).toBe(true);
  expect(target.getAttribute("aria-current")).toBe("location");
  expect(document.querySelector('.file-viewer [data-line="41"]')?.classList).not.toContain(
    "file-line--target",
  );
  // Long files draw only the lines near the screen.
  expect(document.querySelector('.file-viewer [data-line="400"]')).toBeNull();
  expect(openFile).toHaveBeenCalledWith(
    { threadId, source: { kind: "path", path: "/Users/me/Opensteer/src/http.ts" } },
    expect.anything(),
  );

  await act(async () =>
    document
      .querySelector(".file-viewer")
      ?.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })),
  );
  expect(document.querySelector(".file-viewer")).toBeNull();
  expect(document.activeElement).toBe(http);

  await act(async () => chip(container, "gone.ts").click());
  await vi.waitFor(
    () =>
      expect(document.querySelector(".file-viewer")?.textContent).toContain("This isn't available"),
    { timeout: 1000 },
  );
  expect(showLauncher).not.toHaveBeenCalled();
});
