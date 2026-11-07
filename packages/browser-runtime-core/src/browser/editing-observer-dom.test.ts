// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { FakeCdpSession } from "../test-support/fakes.js";
import { PageEditingObserver } from "./editing-observer.js";

type EditingOwner = { publish(): void; stop(): void };
const owner = () => (globalThis as typeof globalThis & { editingOwner: EditingOwner }).editingOwner;

afterEach(() => {
  owner()?.stop();
  document.documentElement.replaceChildren(document.createElement("body"));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["input", "textarea"] as const)(
  "does not mutate page text when refreshing an unchanged empty %s",
  async (tag) => {
    vi.useFakeTimers();
    vi.stubGlobal("visualViewport", null);
    const field = document.createElement(tag);
    document.body.append(field);
    field.focus();
    const cdp = new FakeCdpSession();
    cdp.responses.set("Page.getFrameTree", { frameTree: { frame: { id: "main" } } });
    cdp.responses.set("Page.addScriptToEvaluateOnNewDocument", { identifier: "observer" });
    const observer = new PageEditingObserver(cdp, () => {});
    await observer.start();
    try {
      const binding = cdp.sent.find((entry) => entry.method === "Runtime.addBinding")!.parameters!
        .name as string;
      const publish = vi.fn();
      vi.stubGlobal(binding, publish);
      const source = cdp.sent.find(
        (entry) => entry.method === "Page.addScriptToEvaluateOnNewDocument",
      )!.parameters!.source as string;
      globalThis.eval(source);
      expect(publish).toHaveBeenCalledOnce();
      const mutations: MutationRecord[] = [];
      const changes = new MutationObserver((records) => mutations.push(...records));
      changes.observe(document.documentElement, { characterData: true, subtree: true });
      try {
        owner().publish();
        await vi.advanceTimersToNextFrame();
        expect(publish).toHaveBeenCalledTimes(2);
        expect([...mutations, ...changes.takeRecords()]).toEqual([]);

        field.value = "measurement fixture";
        owner().publish();
        await vi.advanceTimersToNextFrame();
        expect(publish).toHaveBeenCalledTimes(3);
        expect([...mutations, ...changes.takeRecords()].length).toBeGreaterThan(0);
        expect(document.documentElement.textContent).not.toContain(field.value);
      } finally {
        changes.disconnect();
      }
    } finally {
      await observer.close();
    }
  },
);
