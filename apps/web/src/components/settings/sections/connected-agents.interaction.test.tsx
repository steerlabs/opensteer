// @vitest-environment happy-dom
import { createId } from "@opensteer/core";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { HostClientRequestError } from "@opensteer/client/host";
import { MockHostClient, mockConnectedAgents } from "@opensteer/client/mock";
import type { AgentConnection } from "@opensteer/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShellContext } from "../../app-shell.js";
import type { SettingsView } from "../primitives.js";
import { ExternalAgentsSection } from "./external-agents.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let host: MockHostClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const view = {
  administrator: true,
  name: "Mac mini",
  facts: { desktop: true, onThisComputer: true, remote: false },
} as unknown as SettingsView;
const grok = "mcn_00000000-0000-4000-8000-000000000001";
const shopHelper = "mcn_00000000-0000-4000-8000-000000000004";
const oldNotes = "mcn_00000000-0000-4000-8000-000000000005";
const base = "/settings/external-agents";
let path = "";

function Where() {
  path = useLocation().pathname;
  return null;
}

function seeded(connections?: readonly AgentConnection[]) {
  const scene = mockConnectedAgents("seeded");
  return new MockHostClient({ latencyMs: 0, connections: connections ?? scene.connections });
}

async function mount(client: MockHostClient, at = base) {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const context = { hostClient: client, snapshot: client.getSnapshot() } as unknown as ShellContext;
  await act(async () =>
    root!.render(
      <MemoryRouter initialEntries={[at]}>
        <ShellContext value={context}>
          <Routes>
            <Route
              path={`${base}/*`}
              element={
                <>
                  <Where />
                  <ExternalAgentsSection client={client} view={view} />
                </>
              }
            />
          </Routes>
        </ShellContext>
      </MemoryRouter>,
    ),
  );
  return container;
}

function rows(container: HTMLElement, heading: string) {
  const section = [...container.querySelectorAll("section")].find(
    (element) => element.querySelector("h2")?.textContent === heading,
  );
  return [...(section?.querySelectorAll(".connected-agents__row") ?? [])].map((row) => [
    row.querySelector(".card__row-title")?.textContent,
    row.querySelector(".card__row-detail")?.textContent,
  ]);
}
function buttonNamed(container: HTMLElement, text: string) {
  const found = [...document.querySelectorAll("button")].find(
    (button) => button.textContent === text || button.getAttribute("aria-label") === text,
  );
  if (!found) throw new Error(`No button ${text} in ${container.textContent}`);
  return found;
}
const status = (container: HTMLElement) =>
  container.querySelector(".connected-agent__status")?.textContent ?? "";

describe("Connected agents list", () => {
  it("says who is connected and what each can use, then the disconnected ones with their outcome", async () => {
    host = seeded();
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Grok"));
    expect(page.querySelector("h1")?.textContent).toBe("Connected agents");
    expect(rows(page, "Connected")).toEqual([
      ["Grok", "Shopping profile · Supervised"],
      ["Claude", "Everything · Full access"],
      ["Trip planner", "Tasks · Auto"],
      ["Errand", "Nothing chosen · Supervised"],
      ["Claude Code", "Tasks · Auto"],
      ["ChatGPT", "Nothing chosen · Supervised"],
    ]);
    expect(rows(page, "Disconnected")).toEqual([
      ["Shop helper", "Check its last action"],
      ["Old notes agent", "Disconnected"],
    ]);
    expect(page.querySelector(`a[href="${base}/${grok}"]`)).not.toBeNull();
    // A logo only for a platform the Home verified: Claude and ChatGPT, never Grok's domain.
    expect(page.querySelectorAll(".agent-mark .provider-logo")).toHaveLength(2);
  });

  it("asks for nothing more than the list on open", async () => {
    host = seeded();
    const reads = ["integration.computer.apps.approved", "plugins.installed.list"] as const;
    const spies = reads.map((name) => {
      const spy = vi.fn(host!.rpc[name]);
      Object.defineProperty(host!.rpc, name, { value: spy, configurable: true });
      return spy;
    });
    const page = await mount(host);
    await vi.waitFor(() => expect(page.textContent).toContain("Grok"));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("one connected agent", () => {
  it.each([390, 1440])("reads and saves the paired Chrome grant at %d px", async (width) => {
    const sourceId = createId("browserSource");
    host = seeded();
    const read = vi.fn(async () => ({
      ok: true,
      data: {
        extensionDirectory: null,
        sources: [],
        sites: [],
        chromeTabs: [{ paired: true, sourceId, computerName: "Work Mac" }],
      },
    }));
    Object.defineProperty(host.rpc, "browser.sources.get", { value: read, configurable: true });
    const dispatch = vi.spyOn(host, "dispatch");
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(width);
    const page = await mount(host, `${base}/${grok}`);
    page.style.width = `${width}px`;
    const option = page.querySelector<HTMLInputElement>(
      '[aria-label="Tabs you share from Chrome on Work Mac"]',
    )!;
    expect(read).toHaveBeenCalled();
    expect(option.checked).toBe(false);
    await act(async () => option.click());
    await act(async () => buttonNamed(page, "Save").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        grant: expect.objectContaining({
          resources: expect.arrayContaining([{ kind: "chrome-tabs", sourceId }]),
        }),
      }),
    );
  });

  it("shows what it can use, who it says it is, and the honest empty activity", async () => {
    host = seeded();
    const page = await mount(host, `${base}/mcn_00000000-0000-4000-8000-000000000003`);
    await vi.waitFor(() => expect(page.textContent).toContain("Trip planner"));
    expect(status(page)).toContain("Not doing anything");
    expect(page.textContent).toContain("Calls itself");
    expect(page.textContent).toContain("TravelBot Agent");
    expect(page.textContent).toContain("trips.example");
    expect(page.textContent).toContain(
      "This Opensteer doesn’t keep a list of what connected agents did yet.",
    );
    expect(
      page.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.checked,
    ).toBe(true);
    expect(page.querySelector<HTMLInputElement>('input[value="auto"]')!.checked).toBe(true);
  });

  it("saves an edit against the revision it was made on", async () => {
    host = seeded();
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
    expect(page.textContent).not.toContain("Save");
    await act(async () =>
      page.querySelector<HTMLInputElement>('[aria-labelledby="agent-grant-tasks"]')!.click(),
    );
    await act(async () =>
      page.querySelector<HTMLInputElement>('input[value="full-access"]')!.click(),
    );
    await act(async () => buttonNamed(page, "Save").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        connectionId: grok,
        expectedRevision: 1,
        accessMode: "full-access",
        grant: {
          scope: "selected",
          tasks: true,
          resources: [
            { kind: "browser-profile", profileId: "bpr_00000000-0000-4000-8000-000000000003" },
          ],
        },
      }),
    );
    await vi.waitFor(() =>
      expect(page.textContent).toContain("Saved. Grok uses this from its next action."),
    );
    expect(page.querySelector<HTMLInputElement>('input[value="full-access"]')!.checked).toBe(true);
  });

  it("asks before limiting an agent that could do everything", async () => {
    host = seeded();
    const dispatch = vi.spyOn(host, "dispatch");
    const page = await mount(host, `${base}/mcn_00000000-0000-4000-8000-000000000002`);
    // Its verified name is the title; the line under it only says so.
    await vi.waitFor(() =>
      expect(page.querySelector(".agent-who__name")?.textContent).toBe("Verified"),
    );
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Claude"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="selected"]')!.click());
    await act(async () => buttonNamed(page, "Save").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "Limit Claude to what you choose?",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => buttonNamed(page, "Limit").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "connection.update",
        grant: { scope: "selected", tasks: false, resources: [] },
      }),
    );
  });

  it("shows what is set now when another device changed it first", async () => {
    host = seeded();
    const real = host.dispatch.bind(host);
    vi.spyOn(host, "dispatch").mockImplementation(async (command) => {
      if (command.type === "connection.update")
        throw new HostClientRequestError({ code: "conflict", message: "changed", status: 409 });
      return real(command);
    });
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
    await act(async () => page.querySelector<HTMLInputElement>('input[value="auto"]')!.click());
    await act(async () => buttonNamed(page, "Save").click());
    await vi.waitFor(() =>
      expect(page.textContent).toContain("This changed on another device. Showing what’s set now."),
    );
    expect(page.querySelector<HTMLInputElement>('input[value="approval-required"]')!.checked).toBe(
      true,
    );
    expect(page.querySelector('[role="alert"]')).toBeNull();
  });

  it("disconnects after confirming: Revoked at once, then the outcome the Home reports", async () => {
    host = seeded();
    const list = host.rpc["connections.list"];
    const held: (() => void)[] = [];
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
    Object.defineProperty(host.rpc, "connections.list", {
      value: vi.fn(
        (...args: Parameters<typeof list>) =>
          new Promise((done) => held.push(() => done(list(...args)))),
      ),
      configurable: true,
    });
    const dispatch = vi.spyOn(host, "dispatch");
    await act(async () => buttonNamed(page, "Disconnect Grok").click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "It stops right away and can’t use anything again unless you connect it again.",
    );
    expect(dispatch).not.toHaveBeenCalled();
    await act(async () => buttonNamed(page, "Disconnect").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.revoke", connectionId: grok }),
    );
    await vi.waitFor(() => expect(status(page)).toContain("Grok can’t do anything now"));
    expect(
      [...page.querySelectorAll(".connected-agent__steps li")].map((li) =>
        li.getAttribute("data-state"),
      ),
    ).toEqual(["done", "current", "pending"]);
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).toBeNull();
    Object.defineProperty(host.rpc, "connections.list", { value: list, configurable: true });
    await act(async () => {
      for (const release of held) release();
    });
    await vi.waitFor(() => expect(status(page)).toContain("Disconnected"));
    expect(status(page)).toContain("everything it was doing has stopped");
    await act(async () => buttonNamed(page, "Remove from list").click());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "connection.remove", connectionId: grok }),
    );
    await vi.waitFor(() => expect(path).toBe(base));
  });

  it("keeps Stopping and a lost last action apart", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${shopHelper}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Shop helper"));
    expect(status(page)).toContain("Stopping its work");
    expect(status(page)).toContain("Shop helper already can’t use anything");
    expect(page.querySelector(".connected-agent__uncertain")?.textContent).toContain(
      "Check its last action",
    );
    expect(page.textContent).not.toContain("Remove from list");
    expect(page.textContent).not.toContain("Disconnect Shop helper");
  });

  it("offers Remove from list for a stopped agent", async () => {
    host = seeded();
    const page = await mount(host, `${base}/${oldNotes}`);
    await vi.waitFor(() => expect(status(page)).toContain("Disconnected"));
    expect(page.querySelector(".connected-agent__uncertain")).toBeNull();
    expect(buttonNamed(page, "Remove from list")).toBeTruthy();
  });

  it("says when an agent isn't connected anymore", async () => {
    host = seeded([]);
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() =>
      expect(page.textContent).toContain("This agent isn’t connected anymore."),
    );
  });

  it("can't edit an agent on a Home without grants, and says why", async () => {
    const scene = mockConnectedAgents("seeded");
    host = new MockHostClient({
      latencyMs: 0,
      grantsAvailable: false,
      connections: scene.connections.map(({ grant: _grant, ...row }) => row),
    });
    const page = await mount(host, `${base}/${grok}`);
    await vi.waitFor(() => expect(page.textContent).toContain("Disconnect Grok"));
    expect(page.textContent).toContain(
      "Update Opensteer on your Home to choose what this agent can use.",
    );
    expect(page.querySelector('[aria-labelledby="agent-grant-tasks"]')).toBeNull();
  });
});
