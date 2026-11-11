import { withTimeout } from "@opensteer/shared/withTimeout";
import { browserWorkspaceTabUrlMaxLength } from "@opensteer/protocol/browser";
import { describe, expect, it, vi } from "vitest";
import {
  FakeContext,
  FakePage,
  flushMicrotasks,
  withoutTitleSamples,
} from "../test-support/fakes.js";
import { PageFavicon } from "./favicon.js";
import { SurfaceLedger, type SurfaceLedgerEvent } from "./surface-ledger.js";

/** The agent-cursor observer an announced page installs, after its events and size. */
const scriptTargetSetup = [
  { method: "Runtime.enable" },
  {
    method: "Runtime.addBinding",
    parameters: {
      name: expect.stringMatching(/^opensteerTarget_[0-9a-f]{32}$/),
      executionContextName: expect.stringMatching(/^opensteer-targets-/),
    },
  },
  {
    method: "Page.addScriptToEvaluateOnNewDocument",
    parameters: {
      source: expect.any(String),
      worldName: expect.stringMatching(/^opensteer-targets-/),
      runImmediately: true,
    },
  },
];

describe("SurfaceLedger", () => {
  it.each(["reject", "timeout"])(
    "retains a %s close and suspends a late close without retiring the tab",
    async (failure) => {
      vi.useFakeTimers();
      const page = new FakePage({ url: "https://close.test/" });
      page.captureRestore = async () => ({ saved: true });
      const release = vi.fn();
      const ledger = new SurfaceLedger(new FakeContext([page]), { releaseTarget: release });
      await ledger.start();
      await vi.advanceTimersByTimeAsync(0);
      const record = [...ledger.policyRecords()][0]!;
      const live = record.live!;
      const events: SurfaceLedgerEvent[] = [];
      ledger.subscribe((event) => events.push(event));
      const closing = Promise.withResolvers<void>();
      const close = vi.spyOn(page, "close").mockImplementation(() => {
        return closing.promise;
      });
      let lateClose: (() => void) | undefined;
      vi.spyOn(page, "onClose").mockImplementation((listener) => {
        lateClose = listener;
      });
      try {
        let outcome: boolean | undefined;
        void ledger
          .sleep(record.id, () => null)
          .then((value) => {
            outcome = value;
          });
        await vi.advanceTimersByTimeAsync(0);
        expect(close).toHaveBeenCalledOnce();
        expect(record.live).toBe(live);
        expect(record.lease.state).toBe("sleeping");
        expect(release).not.toHaveBeenCalled();
        expect(ledger.stateOf(record.id)).toBe("live");
        if (failure === "reject") {
          closing.reject(new Error("Close refused"));
          await vi.advanceTimersByTimeAsync(0);
        } else await vi.advanceTimersByTimeAsync(2_000);
        expect(outcome).toBe(false);
        expect(record.live).toBe(live);
        expect(record.lease.state).toBe("live");
        expect(record.restore).toMatchObject({ engine: null, bytes: 0 });
        expect(release).not.toHaveBeenCalled();
        page.navigate("https://after-close.test/", "Still live");
        await vi.advanceTimersByTimeAsync(0);
        lateClose!();
        expect(ledger.stateOf(record.id)).toBe("suspended");
        expect(release).toHaveBeenCalledExactlyOnceWith(live.targetId);
        const next = await ledger.wake(record.id);
        expect(next.surface.url).toBe("https://after-close.test/");
        lateClose!();
        expect(ledger.binding(record.id)?.page).toBe(next.page);
        expect(
          events.filter((event) => event.type === "changed" && event.change === "closed"),
        ).toEqual([]);
      } finally {
        closing.resolve();
        close.mockRestore();
        await ledger.close();
        vi.useRealTimers();
      }
    },
  );
  it("rechecks engine protections after capture and allows a noopener sibling", async () => {
    const page = new FakePage({ url: "https://parent.test/" });
    const popup = new FakePage({ url: "https://popup.test/", opener: page });
    const ledger = new SurfaceLedger(new FakeContext([page, popup]));
    await ledger.start();
    const record = [...ledger.policyRecords()].find((record) => record.live?.page === page)!;
    try {
      expect(await ledger.sleep(record.id, () => null)).toBe(false);
      popup.hasOpenerAccess = () => false;
      page.captureRestore = async () => {
        page.keepAwake = () => "download";
        return {};
      };
      expect(await ledger.sleep(record.id, () => null)).toBe(false);
      expect(record.live).not.toBeNull();
      page.captureRestore = async () => ({});
      page.keepAwake = () => null;
      let openerReads = 0;
      page.hasOpenerAccess = () => {
        if (++openerReads === 2) page.keepAwake = () => "upload";
        return false;
      };
      expect(await ledger.sleep(record.id, () => null)).toBe(false);
      expect(record.live).not.toBeNull();
      page.hasOpenerAccess = () => false;
      page.keepAwake = () => null;
      expect(await ledger.sleep(record.id, () => null)).toBe(true);
    } finally {
      await ledger.closeOwnedPages();
      await ledger.close();
    }
  });
  it("sleeps a lease without closing its record and wakes once with the same identity", async () => {
    const page = new FakePage({ url: "https://sleep.test/", title: "Keep me" });
    const context = new FakeContext([page]);
    const ledger = new SurfaceLedger(context);
    const events: SurfaceLedgerEvent[] = [];
    ledger.subscribe((event) => events.push(event));
    await ledger.start();
    await flushMicrotasks();
    const before = ledger.snapshot()[0]!;
    const oldTargetId = await page.targetId();
    const revision = ledger.inventoryRevision;
    const metrics = { width: 800, height: 600, deviceScaleFactor: 1, mobile: false };
    await ledger.agentMetrics(await page.targetId(), metrics);
    try {
      expect(await ledger.sleep(before.id, () => null)).toBe(true);
      expect(ledger.binding(before.id)).toBeNull();
      expect(ledger.surfaceIdForTarget(oldTargetId)).toBe(before.id);
      expect(ledger.stateOf(before.id)).toBe("suspended");
      expect(ledger.snapshot()[0]).toMatchObject({
        id: before.id,
        title: "Keep me",
        url: before.url,
        state: "suspended",
      });
      expect(ledger.inventoryRevision).toBe(revision);
      expect(events.filter((e) => e.type === "changed" && e.change === "closed")).toEqual([]);
      const create = vi.spyOn(context, "createPage");
      const [first, second] = await Promise.all([ledger.wake(before.id), ledger.wake(before.id)]);
      expect(first).toEqual(second);
      expect(ledger.surfaceIdForTarget(oldTargetId)).toBeUndefined();
      expect(ledger.surfaceIdForTarget(first.targetId)).toBe(before.id);
      expect(await ledger.resolveTarget(first.targetId)).toBe(true);
      expect(create).toHaveBeenCalledTimes(1);
      expect(ledger.snapshot()[0]).toMatchObject({
        id: before.id,
        order: before.order,
        openerId: before.openerId,
        sizedByAgent: true,
        state: "live",
      });
      expect(ledger.snapshot()[0]!.documentId).not.toBe(before.documentId);
      expect(ledger.viewportOf(before.id)).toEqual({ width: 800, height: 600 });
      expect(ledger.inventoryRevision).toBe(revision);
    } finally {
      await ledger.closeOwnedPages();
      await ledger.close();
    }
  });

  it.each(["demand", "document", "dialog", "close"])(
    "aborts capture when %s arrives",
    async (kind) => {
      const page = new FakePage({ url: "https://capture.test/" });
      const captured = Promise.withResolvers<unknown | null>();
      const started = Promise.withResolvers<void>();
      Object.assign(page, {
        captureRestore: () => {
          started.resolve();
          return captured.promise;
        },
      });
      const ledger = new SurfaceLedger(new FakeContext([page]));
      await ledger.start();
      const id = ledger.snapshot()[0]!.id;
      const events: SurfaceLedgerEvent[] = [];
      ledger.subscribe((e) => events.push(e));
      let using: Promise<void> | undefined;
      try {
        const sleeping = ledger.sleep(id, (r) => (r.live?.dialog ? "dialog" : null));
        await withTimeout(started.promise, 1000, {
          timeoutError: () => new Error("Capture never started"),
        });
        if (kind === "demand")
          using = ledger.use(id, async () => {
            expect(page.isClosed()).toBe(false);
          });
        if (kind === "document") page.navigate("https://new.test/", "New");
        if (kind === "dialog")
          page.cdpSession.emit("Page.javascriptDialogOpening", { type: "alert", message: "Hold" });
        if (kind === "close") await ledger.closeSurface(id);
        captured.resolve({});
        expect(await sleeping).toBe(false);
        await using;
        expect(events.filter((e) => e.type === "changed" && e.change === "closed")).toHaveLength(
          kind === "close" ? 1 : 0,
        );
        if (kind !== "close") expect(ledger.binding(id)?.page).toBe(page);
      } finally {
        captured.resolve(null);
        await ledger.close();
      }
    },
  );
  it.each(["suspended", "resuming"])(
    "closes a %s record once without leaking a page",
    async (state) => {
      const page = new FakePage({ url: "https://close.test/" });
      const context = new FakeContext([page]);
      const ledger = new SurfaceLedger(context);
      await ledger.start();
      const id = ledger.snapshot()[0]!.id;
      await ledger.sleep(id, () => null);
      const events: SurfaceLedgerEvent[] = [];
      ledger.subscribe((e) => events.push(e));
      const creating = Promise.withResolvers<FakePage>();
      const started = Promise.withResolvers<void>();
      const create = vi.spyOn(context, "createPage").mockImplementation(() => {
        started.resolve();
        return creating.promise;
      });
      let waking: Promise<unknown> | undefined;
      try {
        if (state === "resuming") {
          waking = ledger.wake(id);
          void waking.catch(() => undefined);
          await withTimeout(started.promise, 1000, {
            timeoutError: () => new Error("Wake never created a page"),
          });
        }
        await ledger.closeSurface(id);
        const next = new FakePage();
        creating.resolve(next);
        if (waking) {
          await expect(waking).rejects.toMatchObject({ code: "not_found" });
          expect(next.isClosed()).toBe(true);
        }
        expect(create).toHaveBeenCalledTimes(state === "resuming" ? 1 : 0);
        expect(ledger.snapshot()).toEqual([]);
        expect(events.filter((e) => e.type === "changed" && e.change === "closed")).toHaveLength(1);
      } finally {
        creating.resolve(new FakePage());
        await ledger.close();
      }
    },
  );
  it.each(["createPage", "Page.enable", "Page.getFrameTree", "Emulation.setDeviceMetricsOverride"])(
    "keeps a failed %s wake suspended and permits a new address wake",
    async (failure) => {
      const page = new FakePage({ url: "https://retry.test/" });
      const context = new FakeContext([page]);
      const ledger = new SurfaceLedger(context);
      await ledger.start();
      const id = ledger.snapshot()[0]!.id;
      await ledger.sleep(id, () => null);
      const events: SurfaceLedgerEvent[] = [];
      ledger.subscribe((event) => events.push(event));
      const failedPage = new FakePage();
      let lateClose: (() => void) | undefined;
      const onClose = failedPage.onClose.bind(failedPage);
      vi.spyOn(failedPage, "onClose").mockImplementation((listener) => {
        lateClose = listener;
        onClose(listener);
      });
      const create = vi.spyOn(context, "createPage").mockImplementationOnce(async () => {
        if (failure === "createPage") throw new Error("wake refused");
        failedPage.cdpSession.responses.set(failure, () => {
          throw new Error("wake refused");
        });
        context.addPage(failedPage);
        return failedPage;
      });
      try {
        await expect(ledger.wake(id)).rejects.toMatchObject({
          code: "conflict",
          retryable: true,
          cause: { message: "wake refused" },
        });
        expect(ledger.stateOf(id)).toBe("suspended");
        expect(ledger.snapshot()).toMatchObject([
          { id, state: "suspended", url: "https://retry.test/" },
        ]);
        expect(
          events.filter((event) => event.type === "changed" && event.change === "closed"),
        ).toEqual([]);
        if (failure !== "createPage") expect(failedPage.isClosed()).toBe(true);
        const resumed = await ledger.wake(id);
        expect(resumed.surface.id).toBe(id);
        expect(create).toHaveBeenCalledTimes(2);
        expect((resumed.page as FakePage).cdpSession.sent).toContainEqual({
          method: "Page.navigate",
          parameters: { url: "https://retry.test/" },
        });
        lateClose?.();
        await flushMicrotasks();
        expect(ledger.binding(id)?.page).toBe(resumed.page);
        expect(ledger.surfaceIdForTarget(await failedPage.targetId())).toBeUndefined();
        expect(ledger.surfaceIdForTarget(resumed.targetId)).toBe(id);
        await ledger.closeSurface(id);
        expect(ledger.surfaceIdForTarget(resumed.targetId)).toBeUndefined();
        expect(
          events.filter((event) => event.type === "changed" && event.change === "closed"),
        ).toHaveLength(1);
      } finally {
        await ledger.closeOwnedPages();
        await ledger.close();
      }
    },
  );
  it("keeps title, address, opener and size through a delayed first wake commit", async () => {
    const page = new FakePage({ url: "https://keep.test/", title: "Saved title" });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    await flushMicrotasks();
    const before = ledger.snapshot()[0]!;
    try {
      await ledger.sleep(before.id, () => null);
      const duringWake: string[] = [];
      ledger.subscribe((event) => {
        if (event.type === "geometry") duringWake.push(ledger.toRecord(before.id)!.state);
      });
      const binding = await ledger.wake(before.id);
      expect(duringWake).toEqual(["suspended"]);
      expect(binding.surface).toMatchObject({
        title: before.title,
        url: before.url,
        order: before.order,
        openerId: before.openerId,
      });
      expect(binding.surface.documentId).not.toBe(before.documentId);
      (binding.page as FakePage).navigate("https://redirect.test/", "New title");
      await flushMicrotasks();
      expect(ledger.snapshot()[0]).toMatchObject({
        url: "https://redirect.test/",
        title: "New title",
      });
    } finally {
      await ledger.closeOwnedPages();
      await ledger.close();
    }
  });
  it("initializes a popup from its committed document when enable misses the first commit", async () => {
    const page = new FakePage({ url: "about:blank" });
    const deliver = page.cdpSession.emit.bind(page.cdpSession);
    let enabled = false;
    vi.spyOn(page.cdpSession, "emit").mockImplementation((method, parameters) => {
      if (method !== "Page.frameNavigated" || enabled) deliver(method, parameters);
    });
    page.cdpSession.responses.set("Page.enable", () => {
      page.navigate("https://middle.test/destination", "Middle destination");
      enabled = true;
      return {};
    });
    const ledger = new SurfaceLedger(new FakeContext([page]));
    try {
      await ledger.start();
      await vi.waitFor(
        () =>
          expect(ledger.snapshot()[0]).toMatchObject({
            url: "https://middle.test/destination",
            title: "Middle destination",
          }),
        { timeout: 1000 },
      );
    } finally {
      await ledger.close();
    }
  });

  it.each(["document", "same-document"])(
    "does not overwrite a newer %s navigation with the initial frame snapshot",
    async (kind) => {
      const page = new FakePage({ url: "https://old.test/" });
      const old = {
        frameTree: {
          frame: { id: await page.targetId(), loaderId: page.loaderId, url: page.url() },
        },
      };
      const snapshot = Promise.withResolvers<typeof old>();
      const requested = Promise.withResolvers<void>();
      const answer = page.cdpSession.responses.get("Page.getFrameTree");
      let first = true;
      page.cdpSession.responses.set("Page.getFrameTree", (parameters?: Record<string, unknown>) => {
        if (first) {
          first = false;
          requested.resolve();
          return snapshot.promise;
        }
        return typeof answer === "function" ? answer(parameters) : answer;
      });
      const ledger = new SurfaceLedger(new FakeContext([page]));
      const starting = ledger.start();
      try {
        await withTimeout(requested.promise, 1000, {
          timeoutError: () => new Error("Initial frame snapshot never started"),
        });
        const url = kind === "document" ? "https://new.test/" : "https://old.test/#new";
        if (kind === "document") page.navigate(url, "New document");
        else page.setMetadata("New document", url);
        snapshot.resolve(old);
        await starting;
        await vi.waitFor(
          () => expect(ledger.snapshot()[0]).toMatchObject({ url, title: "New document" }),
          { timeout: 1000 },
        );
      } finally {
        snapshot.resolve(old);
        await ledger.close();
      }
    },
  );

  it.each(["reply-first", "commit-first", "push-state", "redirect"] as const)(
    "emits the frozen main-frame commit exactly once (%s)",
    async (ordering) => {
      const page = new FakePage();
      const ledger = new SurfaceLedger(new FakeContext([page]));
      const events: SurfaceLedgerEvent[] = [];
      ledger.subscribe((event) => events.push(event));
      await ledger.start();
      try {
        const id = ledger.snapshot()[0]!.id;
        const reply = Promise.withResolvers<{ loaderId: string }>();
        page.cdpSession.responses.set("Page.navigate", () => reply.promise);
        const navigation = ledger.navigate(id, "https://start.test/", "person-navigation");
        const commit = () =>
          page.cdpSession.emit("Page.frameNavigated", {
            frame: {
              id: "main",
              loaderId: "person",
              url: "https://redirect.test/",
              urlFragment: "#kept",
            },
          });
        if (ordering === "reply-first") {
          reply.resolve({ loaderId: "person" });
          await navigation;
        }
        // Child frames cannot satisfy the person's navigation.
        page.cdpSession.emit("Page.frameNavigated", {
          frame: { id: "child", parentId: "main", loaderId: "person", url: "https://child.test/" },
        });
        commit();
        const documentId = ledger.snapshot()[0]!.documentId;
        if (ordering === "push-state")
          page.cdpSession.emit("Page.navigatedWithinDocument", {
            frameId: ledger.binding(id)!.targetId,
            url: "https://redirect.test/agent-route",
            navigationType: "historyApi",
          });
        if (ordering === "redirect") page.navigate("https://agent.test/", "Agent");
        reply.resolve({ loaderId: "person" });
        await navigation;
        const committed = events.filter((event) => event.type === "navigation.committed");
        expect(committed).toEqual([
          {
            type: "navigation.committed",
            navigationId: "person-navigation",
            surfaceId: id,
            documentId,
            url: "https://redirect.test/#kept",
          },
        ]);
        expect(ledger.snapshot()[0]).not.toHaveProperty("navigationId");
        page.navigate("https://later.test/", "Later");
        expect(events.filter((event) => event.type === "navigation.committed")).toEqual(committed);
      } finally {
        await ledger.close();
      }
    },
  );

  it.each(["reply-first", "event-first"] as const)(
    "matches only same-document fragment events (%s)",
    async (ordering) => {
      const page = new FakePage({ url: "https://page.test/" });
      const ledger = new SurfaceLedger(new FakeContext([page]));
      const events: SurfaceLedgerEvent[] = [];
      ledger.subscribe((event) => events.push(event));
      await ledger.start();
      try {
        const id = ledger.snapshot()[0]!.id;
        const documentId = ledger.snapshot()[0]!.documentId;
        const frameId = ledger.binding(id)!.targetId;
        const reply = Promise.withResolvers<{ frameId: string }>();
        page.cdpSession.responses.set("Page.navigate", () => reply.promise);
        const navigation = ledger.navigate(
          id,
          "https://page.test/#fragment",
          "fragment-navigation",
        );
        if (ordering === "reply-first") {
          reply.resolve({ frameId });
          await navigation;
        }
        for (const parameters of [
          { frameId: "child", url: "https://page.test/#fragment", navigationType: "fragment" },
          { frameId, url: "https://page.test/#fragment", navigationType: "historyApi" },
        ])
          page.cdpSession.emit("Page.navigatedWithinDocument", parameters);
        expect(events.filter((event) => event.type === "navigation.committed")).toEqual([]);
        page.cdpSession.emit("Page.navigatedWithinDocument", {
          frameId,
          url: "https://page.test/#fragment",
          navigationType: "fragment",
        });
        page.cdpSession.emit("Page.navigatedWithinDocument", {
          frameId,
          url: "https://page.test/#agent",
          navigationType: "historyApi",
        });
        reply.resolve({ frameId });
        await navigation;
        expect(events.filter((event) => event.type === "navigation.committed")).toEqual([
          {
            type: "navigation.committed",
            navigationId: "fragment-navigation",
            surfaceId: id,
            documentId,
            url: "https://page.test/#fragment",
          },
        ]);
      } finally {
        await ledger.close();
      }
    },
  );

  it("matches overlapping bindings independently when A commits before its reply and B's commit", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    const events: SurfaceLedgerEvent[] = [];
    ledger.subscribe((event) => events.push(event));
    await ledger.start();
    try {
      const id = ledger.snapshot()[0]!.id;
      const replyA = Promise.withResolvers<{ loaderId: string }>();
      page.cdpSession.responses.set("Page.navigate", () => replyA.promise);
      const a = ledger.navigate(id, "https://a.test/", "a");
      page.cdpSession.responses.set("Page.navigate", { loaderId: "loader-b" });
      await ledger.navigate(id, "https://b.test/", "b");
      const commit = (loaderId: string, url: string) =>
        page.cdpSession.emit("Page.frameNavigated", {
          frame: { id: "main", loaderId, url },
        });
      commit("loader-a", "https://a.test/");
      replyA.resolve({ loaderId: "loader-a" });
      await a;
      commit("unrelated", "https://agent.test/");
      commit("loader-b", "https://b.test/");
      expect(events.filter((event) => event.type === "navigation.committed")).toMatchObject([
        { navigationId: "a", url: "https://a.test/" },
        { navigationId: "b", url: "https://b.test/" },
      ]);
      for (let index = 0; index < 40; index++) {
        page.cdpSession.responses.set("Page.navigate", { loaderId: `loader-${index}` });
        await ledger.navigate(id, "https://page.test/", `navigation-${index}`);
      }
      commit("loader-0", "https://page.test/");
      expect(events.filter((event) => event.type === "navigation.committed")).toHaveLength(2);
    } finally {
      await ledger.close();
    }
  });

  it("bounds commits retained while a navigation reply is pending", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    const events: SurfaceLedgerEvent[] = [];
    ledger.subscribe((event) => events.push(event));
    await ledger.start();
    try {
      const reply = Promise.withResolvers<{ loaderId: string }>();
      page.cdpSession.responses.set("Page.navigate", () => reply.promise);
      const navigation = ledger.navigate(ledger.snapshot()[0]!.id, "https://page.test/", "evicted");
      for (let index = 0; index < 40; index++)
        page.cdpSession.emit("Page.frameNavigated", {
          frame: { id: "main", loaderId: `loader-${index}`, url: "https://page.test/" },
        });
      reply.resolve({ loaderId: "loader-0" });
      await navigation;
      expect(events.filter((event) => event.type === "navigation.committed")).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it("drops downloads, missing loaders, errors and closed-surface bindings", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    const events: SurfaceLedgerEvent[] = [];
    ledger.subscribe((event) => events.push(event));
    await ledger.start();
    try {
      const id = ledger.snapshot()[0]!.id;
      for (const result of [
        {},
        { frameId: "main" },
        { loaderId: "download", isDownload: true },
        { loaderId: "error", errorText: "net::ERR_FAILED" },
      ]) {
        page.cdpSession.responses.set("Page.navigate", result);
        await ledger.navigate(id, "https://download.test/", "no-visit");
        page.cdpSession.emit("Page.frameNavigated", {
          frame: {
            id: "main",
            loaderId: "loaderId" in result ? result.loaderId : "missing",
            url: "https://page.test/",
          },
        });
      }
      page.cdpSession.responses.set("Page.navigate", () => {
        throw new Error("Navigation refused");
      });
      await expect(ledger.navigate(id, "https://page.test/", "failed")).rejects.toThrow(
        "Navigation refused",
      );
      const reply = Promise.withResolvers<{ loaderId: string }>();
      page.cdpSession.responses.set("Page.navigate", () => reply.promise);
      const closed = ledger.navigate(id, "https://page.test/", "closed");
      page.navigate("https://page.test/", "Closed");
      await page.close();
      reply.resolve({ loaderId: page.loaderId });
      await closed;
      expect(events.filter((event) => event.type === "navigation.committed")).toEqual([]);
    } finally {
      await ledger.close();
    }
  });

  it("clears a failed navigation when a later document commits, as after Reload", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      const id = ledger.snapshot()[0]!.id;
      page.cdpSession.responses.set("Page.navigate", {
        loaderId: "error",
        errorText: "net::ERR_NAME_NOT_RESOLVED",
      });
      await ledger.navigate(id, "https://offline.test/");
      page.cdpSession.emit("Page.frameNavigated", {
        frame: {
          id: "main",
          loaderId: "error",
          url: "chrome-error://chromewebdata/",
          unreachableUrl: "https://offline.test/",
        },
      });
      expect(ledger.snapshot()[0]).toMatchObject({
        navigationFailed: true,
        url: "https://offline.test/",
      });
      const favicon = vi.spyOn(PageFavicon.prototype, "refresh");
      await ledger.refresh(id);
      expect(ledger.snapshot()[0]).toMatchObject({ url: "https://offline.test/" });
      expect(ledger.committedUrl(id)).toBe("chrome-error://chromewebdata/");
      expect(favicon.mock.calls.at(-1)?.[1]).toBe("chrome-error://chromewebdata/");
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", loaderId: "reloaded", url: "https://offline.test/" },
      });
      expect(ledger.snapshot()[0]).not.toHaveProperty("navigationFailed");
    } finally {
      await ledger.close();
    }
  });

  it("restores a failed tab to the address it tried, without credentials it carried", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      const id = ledger.snapshot()[0]!.id;
      page.cdpSession.emit("Page.frameNavigated", {
        frame: {
          id: "main",
          loaderId: "error",
          url: "chrome-error://chromewebdata/",
          unreachableUrl: "https://person:s3cret@offline.test/page?q=1#part",
        },
      });
      expect(ledger.snapshot()[0]).toMatchObject({ url: "https://offline.test/page?q=1#part" });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)).toMatchObject({
        url: "https://offline.test/page?q=1#part",
      });
      expect(ledger.committedUrl(id)).toBe("chrome-error://chromewebdata/");
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", loaderId: "next", url: "https://online.test/" },
      });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)).toMatchObject({
        url: "https://online.test/",
      });
    } finally {
      await ledger.close();
    }
  });

  it("never truncates an overlong address a failed tab tried", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      page.cdpSession.emit("Page.frameNavigated", {
        frame: {
          id: "main",
          loaderId: "error",
          url: "chrome-error://chromewebdata/",
          unreachableUrl: `https://offline.test/${"a".repeat(browserWorkspaceTabUrlMaxLength)}`,
        },
      });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)).toMatchObject({
        url: "opensteer:unavailable-url",
      });
    } finally {
      await ledger.close();
    }
  });

  it("marks a failed commit no ledger navigation asked for, as an agent's own navigation is", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      page.cdpSession.emit("Page.frameNavigated", {
        frame: {
          id: "main",
          loaderId: "error",
          url: "chrome-error://chromewebdata/",
          unreachableUrl: "https://offline.test/page",
        },
      });
      expect(ledger.snapshot()[0]).toMatchObject({
        navigationFailed: true,
        url: "https://offline.test/page",
      });
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", loaderId: "next", url: "https://online.test/" },
      });
      expect(ledger.snapshot()[0]).not.toHaveProperty("navigationFailed");
      expect(ledger.snapshot()[0]).toMatchObject({ url: "https://online.test/" });
    } finally {
      await ledger.close();
    }
  });

  it("retains validated fragments on committed full navigations", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", url: "https://example.test/", urlFragment: "#/document/42" },
      });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe(
        "https://example.test/#/document/42",
      );
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "child", parentId: "main", url: "https://child.test/", urlFragment: "#child" },
      });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe(
        "https://example.test/#/document/42",
      );
      for (const urlFragment of [undefined, 42, "invalid"]) {
        page.cdpSession.emit("Page.frameNavigated", {
          frame: { id: "main", url: "https://example.test/next", urlFragment },
        });
        expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe("https://example.test/next");
      }
    } finally {
      await ledger.close();
    }
  });
  it("marks over-limit committed URLs unavailable instead of truncating them", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    await ledger.start();
    try {
      const url = `https://example.test/${"x".repeat(9000)}`;
      page.cdpSession.emit("Page.frameNavigated", { frame: { id: "main", url } });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe(url);
      const limitUrl = "https://example.test/".padEnd(16384, "x");
      page.cdpSession.emit("Page.frameNavigated", { frame: { id: "main", url: limitUrl } });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe(limitUrl);
      page.cdpSession.emit("Page.frameNavigated", {
        frame: { id: "main", url: limitUrl, urlFragment: "#over" },
      });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe("opensteer:unavailable-url");
      page.cdpSession.emit("Page.navigatedWithinDocument", {
        frameId: "main",
        url: `${limitUrl}x`,
      });
      expect(ledger.toRecord(ledger.snapshot()[0]!.id)?.url).toBe("opensteer:unavailable-url");
    } finally {
      await ledger.close();
    }
  });
  it("rejects unknown surfaces and isolates failing subscribers", async () => {
    const page = new FakePage();
    const ledger = new SurfaceLedger(new FakeContext([page]));
    const healthy = vi.fn();
    ledger.subscribe(() => {
      throw new Error("listener failed");
    });
    ledger.subscribe(healthy);
    await ledger.start();

    await expect(
      ledger.activate("surface_missing" as Parameters<typeof ledger.activate>[0]),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(healthy).toHaveBeenCalled();
    await ledger.close();
  });

  it("treats active selection as logical state and makes reselection idempotent", async () => {
    const first = new FakePage({ title: "First" });
    const second = new FakePage({ title: "Second" });
    const ledger = new SurfaceLedger(new FakeContext([first, second]));
    const events: SurfaceLedgerEvent[] = [];
    ledger.subscribe((event) => events.push(event));
    await ledger.start();

    const [firstSurface, secondSurface] = ledger.snapshot();
    if (!firstSurface || !secondSurface) throw new Error("Expected two surfaces.");
    expect(secondSurface.active).toBe(true);

    const beforeSelection = events.length;
    await ledger.activate(firstSurface.id);
    expect(ledger.active()?.surface.id).toBe(firstSurface.id);
    expect(events.slice(beforeSelection)).toEqual([
      expect.objectContaining({ surfaces: expect.any(Array), type: "snapshot" }),
    ]);

    const beforeReselection = events.length;
    await ledger.activate(firstSurface.id);
    expect(ledger.active()?.surface.id).toBe(firstSurface.id);
    expect(events).toHaveLength(beforeReselection);
    await ledger.close();
  });

  it("keeps tab 65 and popup 129 open and listed", async () => {
    const root = new FakePage();
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    try {
      for (let index = 1; index < 128; index++) await ledger.openSurface();
      expect(ledger.snapshot()).toHaveLength(128);
      const popup = new FakePage({ opener: root, title: "Popup 129" });
      context.addPage(popup);
      await vi.waitFor(() => expect(ledger.snapshot()).toHaveLength(129));
      expect(ledger.snapshot().at(-1)).toMatchObject({ title: "Popup 129" });
      expect(popup.closeCount).toBe(0);
      expect(ledger.snapshot().every((surface) => surface.state === "live")).toBe(true);
    } finally {
      await ledger.closeOwnedPages();
      await ledger.close();
    }
  });

  it("adopts only openerless targets created through the scoped session router", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context, { rootPages: [root] });
    await ledger.start();

    const unrelated = new FakePage({ title: "Unrelated" });
    context.addPage(unrelated);
    await flushMicrotasks();
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);

    expect(await ledger.adoptTarget(await unrelated.targetId())).toBe(true);
    expect(ledger.snapshot()).toEqual([
      expect.objectContaining({ active: true, title: "Root" }),
      expect.objectContaining({ active: false, title: "Unrelated" }),
    ]);

    await ledger.close();
  });

  it("waits for an in-flight discovered target before resolving it, without selecting it", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context, { rootPages: [root] });
    await ledger.start();

    let releaseMetrics: (() => void) | undefined;
    const metricsReady = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const popup = new FakePage({ opener: root, title: "Popup" });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", async () => {
      await metricsReady;
      return {};
    });
    context.addPage(popup);

    let resolved = false;
    const resolution = ledger.resolveTarget(await popup.targetId()).then((found) => {
      resolved = true;
      return found;
    });
    await flushMicrotasks();
    expect(resolved).toBe(false);
    releaseMetrics?.();
    await expect(resolution).resolves.toBe(true);
    // Resolving a target for an agent never moves the person's selection.
    expect(ledger.active()?.targetId).toBe(await root.targetId());
    await ledger.close();
  });

  it.each([
    { name: "a recent input from the person", follows: true },
    { name: "an agent command after the input", agent: true, follows: false },
    { name: "an input from nobody known", viewer: null, follows: false },
    { name: "an input past its activation", lateMs: 5_000, follows: false },
    { name: "a tab opened behind its opener", background: true, follows: false },
  ])("a popup after $name follows its viewer: $follows", async (scenario) => {
    const viewer = "00000000-0000-4000-8000-000000000001";
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    const followers: string[] = [];
    ledger.subscribe((event) => {
      if (event.type === "popup") followers.push(event.consumerToken);
    });
    await ledger.start();
    const open = async () => {
      const popup = new FakePage({ opener: root, title: "Popup" });
      if (scenario.background) Object.assign(popup, { openedInBackground: true });
      context.addPage(popup);
      await ledger.resolveTarget(await popup.targetId());
    };
    // The input's own timestamp must be exact, or a millisecond tick makes a late input young.
    const at = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(at);
    ledger.recordViewerInput(ledger.snapshot()[0]!.id, scenario.viewer === null ? null : viewer);
    if (scenario.agent) ledger.recordAgentCommand(await root.targetId());
    now.mockReturnValue(at + (scenario.lateMs ?? 0));
    await open();
    await open();
    now.mockRestore();
    expect(followers).toEqual(scenario.follows ? [viewer] : []);
    await ledger.close();
  });

  it("gives every page and popup its starting size before announcing it", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context, {
      initialViewport: { devicePixelRatio: 1, height: 600, width: 900 },
    });
    await ledger.start();
    // Page events come first, so a dialog the page opens while it is sized is seen.
    expect(withoutTitleSamples(root.cdpSession.sent)).toEqual([
      { method: "Page.enable" },
      {
        method: "Emulation.setDeviceMetricsOverride",
        parameters: {
          deviceScaleFactor: 1,
          height: 600,
          mobile: false,
          // Resizing a window does not resize its monitor: one ordinary screen.
          screenHeight: 1_080,
          screenWidth: 1_920,
          width: 900,
        },
      },
      ...scriptTargetSetup,
    ]);

    const popup = new FakePage({ opener: root, title: "Popup" });
    context.addPage(popup);
    await flushMicrotasks();
    expect(withoutTitleSamples(popup.cdpSession.sent)).toMatchObject([
      { method: "Page.enable" },
      { method: "Emulation.setDeviceMetricsOverride", parameters: { height: 600, width: 900 } },
      ...scriptTargetSetup,
    ]);
    expect(ledger.snapshot()).toContainEqual(
      expect.objectContaining({ active: false, title: "Popup" }),
    );
    await ledger.close();
  });

  it("keeps target-local viewports isolated across sessions sharing one context", async () => {
    const first = new FakePage({ title: "First session" });
    const second = new FakePage({ title: "Second session" });
    const context = new FakeContext([first, second]);
    const firstLedger = new SurfaceLedger(context, { rootPages: [first] });
    const secondLedger = new SurfaceLedger(context, { rootPages: [second] });
    await firstLedger.start();
    await secondLedger.start();

    const firstSurface = firstLedger.snapshot()[0];
    const secondSurface = secondLedger.snapshot()[0];
    if (!firstSurface || !secondSurface) throw new Error("Missing session surfaces");
    await firstLedger.fitViewport(firstSurface.id, { height: 600, width: 900 });
    await secondLedger.fitViewport(secondSurface.id, { height: 500, width: 700 });
    expect(
      first.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 600, width: 900 });
    expect(
      second.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 500, width: 700 });

    await firstLedger.close();
    await secondLedger.close();
  });

  it("closes and detaches an explicitly opened surface when initial metrics fail", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const failed = new FakePage({ title: "Failed tab" });
    failed.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("metrics failed");
    });
    context.createPage = async () => {
      context.addPage(failed);
      return failed;
    };

    await expect(ledger.openSurface()).rejects.toThrow("metrics failed");
    expect(failed.closeCount).toBe(1);
    expect(failed.cdpSession.detachCount).toBe(1);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("closes and detaches a discovered popup when initial metrics fail", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const failed = new FakePage({ opener: root, title: "Failed popup" });
    failed.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("metrics failed");
    });

    context.addPage(failed);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(failed.closeCount).toBe(1);
    expect(failed.cdpSession.detachCount).toBe(1);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("closes a discovered popup when its platform CDP channel cannot be acquired", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const failed = new FakePage({ opener: root, title: "Failed popup" });
    failed.cdp = async () => {
      throw new Error("CDP attach failed");
    };

    context.addPage(failed);
    await flushMicrotasks();
    await flushMicrotasks();
    expect(failed.closeCount).toBe(1);
    expect(failed.cdpSession.detachCount).toBe(0);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("serializes a Fit with in-flight registration and sizes only the page it names", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const rootSurface = ledger.snapshot()[0];
    if (!rootSurface) throw new Error("Missing root surface");

    let releasePopupMetrics: () => void = () => undefined;
    const popupMetrics = new Promise<void>((resolve) => {
      releasePopupMetrics = resolve;
    });
    const popup = new FakePage({ opener: root, title: "Popup" });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => popupMetrics);
    context.addPage(popup);
    await flushMicrotasks();
    // The popup's starting size is in flight.
    expect(popup.cdpSession.sent.map((command) => command.method)).toEqual([
      "Page.enable",
      "Page.getFrameTree",
      "Emulation.setDeviceMetricsOverride",
    ]);

    const resize = ledger.fitViewport(rootSurface.id, { height: 600, width: 900 });
    releasePopupMetrics();
    await resize;
    await flushMicrotasks();
    expect(
      popup.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .map((command) => command.parameters),
    ).toEqual([expect.objectContaining({ height: 729, width: 709 })]);
    expect(
      root.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 600, width: 900 });
    await ledger.close();
  });

  it("settles popup geometry before exposing its target to an agent", async () => {
    const root = new FakePage({ title: "Root" });
    const context = new FakeContext([root]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();

    let releaseMetrics: () => void = () => undefined;
    const metrics = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    const popup = new FakePage({ opener: root, title: "Popup" });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => metrics);
    context.addPage(popup);
    await flushMicrotasks();

    let settled = false;
    const targetReady = ledger.settleTarget(await popup.targetId()).then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled).toBe(false);
    releaseMetrics();
    await targetReady;
    expect(settled).toBe(true);
    expect(ledger.snapshot()).toContainEqual(
      expect.objectContaining({ active: false, title: "Popup" }),
    );
    await ledger.close();
  });

  it("serializes surface closure with an in-flight viewport write", async () => {
    const root = new FakePage({ title: "Root" });
    const popup = new FakePage({ opener: root, title: "Popup" });
    const context = new FakeContext([root, popup]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const popupSurface = ledger.snapshot().find((surface) => surface.title === "Popup");
    if (!popupSurface) throw new Error("Missing popup surface");

    let releaseMetrics: () => void = () => undefined;
    const metrics = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => metrics);
    const resize = ledger.fitViewport(popupSurface.id, { height: 600, width: 900 });
    await flushMicrotasks();
    const close = ledger.closeSurface(popupSurface.id);
    releaseMetrics();

    await expect(resize).resolves.toMatchObject({ changed: true });
    await close;
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ title: "Root" })]);
    await ledger.close();
  });

  it("reports a page that cannot take its size and leaves every page open", async () => {
    const root = new FakePage({ title: "Root" });
    const popup = new FakePage({ opener: root, title: "Popup" });
    const context = new FakeContext([root, popup]);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const popupSurface = ledger.snapshot().find((surface) => surface.title === "Popup");
    const rootSurface = ledger.snapshot().find((surface) => surface.title === "Root");
    if (!popupSurface || !rootSurface) throw new Error("Missing surfaces");
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      throw new Error("live target rejected metrics");
    });
    const rootWrites = root.cdpSession.sent.length;

    await expect(ledger.fitViewport(popupSurface.id, { height: 600, width: 900 })).rejects.toThrow(
      "live target rejected metrics",
    );
    await flushMicrotasks();
    expect(popup.closeCount).toBe(0);
    expect(ledger.snapshot()).toHaveLength(2);
    expect(root.cdpSession.sent).toHaveLength(rootWrites);
    // The refused size never became the page's own: its popup starts at the old one.
    const nested = new FakePage({ opener: popup, title: "Nested popup" });
    context.addPage(nested);
    await flushMicrotasks();
    expect(withoutTitleSamples(nested.cdpSession.sent)).toMatchObject([
      { method: "Page.enable" },
      { method: "Emulation.setDeviceMetricsOverride", parameters: { height: 729, width: 709 } },
      ...scriptTargetSetup,
    ]);

    // The session keeps serving later writes to any page.
    await ledger.fitViewport(rootSurface.id, { height: 500, width: 700 });
    expect(
      root.cdpSession.sent
        .filter((command) => command.method === "Emulation.setDeviceMetricsOverride")
        .at(-1)?.parameters,
    ).toMatchObject({ height: 500, width: 700 });
    await ledger.closeOwnedPages();
    await ledger.close();
  });

  it("ignores a viewport failure from a surface that closed as the write landed", async () => {
    const root = new FakePage({ title: "Root" });
    const popup = new FakePage({ opener: root, title: "Popup" });
    const ledger = new SurfaceLedger(new FakeContext([root, popup]));
    await ledger.start();
    const popupSurface = ledger.snapshot().find((surface) => surface.title === "Popup");
    if (!popupSurface) throw new Error("Missing popup surface");
    popup.cdpSession.responses.set("Emulation.setDeviceMetricsOverride", () => {
      popup.crash();
      throw new Error("target closed mid-write");
    });

    await expect(
      ledger.fitViewport(popupSurface.id, { height: 600, width: 900 }),
    ).rejects.toMatchObject({ code: "not_found" });
    await flushMicrotasks();
    // The benign close race is not a reason to close a page the engine already
    // closed, and the page's own close path still retires the surface.
    expect(popup.closeCount).toBe(0);
    expect(ledger.snapshot()).toEqual([expect.objectContaining({ active: true, title: "Root" })]);
    await ledger.closeOwnedPages();
    await ledger.close();
  });

  it("requires a bounded DPR-1 logical viewport", async () => {
    const context = new FakeContext([new FakePage()]);
    expect(
      () =>
        new SurfaceLedger(context, {
          initialViewport: { devicePixelRatio: 2, height: 600, width: 900 },
        }),
    ).toThrow(/DPR 1/);
    const ledger = new SurfaceLedger(context);
    await ledger.start();
    const surface = ledger.snapshot()[0];
    if (!surface) throw new Error("Missing surface");
    await expect(
      Promise.resolve().then(() =>
        ledger.fitViewport(surface.id, { height: 10_000, width: 10_000 }),
      ),
    ).rejects.toThrow(/bounded/);
    await ledger.close();
  });
});

it("reads native or remote viewer attribution without consuming it, after agent commands and within activation lifetime", async () => {
  const page = new FakePage(),
    context = new FakeContext([page]);
  const ledger = new SurfaceLedger(context);
  await ledger.start();
  const surfaceId = ledger.active()!.surface.id;
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(10_000);
    ledger.recordViewerInput(surfaceId, "native-viewer", true);
    expect(ledger.latestViewerInput(surfaceId)).toMatchObject({
      consumerToken: "native-viewer",
      native: true,
    });
    expect(ledger.latestViewerInput(surfaceId)).toMatchObject({
      consumerToken: "native-viewer",
      native: true,
    });
    const popup = new FakePage({ opener: page });
    context.addPage(popup);
    await withTimeout(ledger.resolveTarget(await popup.targetId()), 1000, {
      timeoutError: () => new Error("The attributed popup never registered"),
    });
    expect(ledger.latestViewerInput(surfaceId)).toMatchObject({
      consumerToken: "native-viewer",
      native: true,
    });
    ledger.recordAgentCommand(await page.targetId());
    expect(ledger.latestViewerInput(surfaceId)).toBeNull();
    ledger.recordViewerInput(surfaceId, "remote-viewer");
    expect(ledger.latestViewerInput(surfaceId)).toMatchObject({
      consumerToken: "remote-viewer",
      native: false,
    });
    now.mockReturnValue(15_000);
    expect(ledger.latestViewerInput(surfaceId)).toBeNull();
    ledger.recordViewerInput(surfaceId, null, true);
    expect(ledger.latestViewerInput(surfaceId)).toBeNull();
  } finally {
    now.mockRestore();
    await ledger.close();
  }
});

it("names the viewer whose input a page edit followed, judged by when the edit happened", async () => {
  const page = new FakePage(),
    context = new FakeContext([page]);
  const ledger = new SurfaceLedger(context);
  await ledger.start();
  const surfaceId = ledger.active()!.surface.id;
  const targetId = await page.targetId();
  const now = vi.spyOn(Date, "now");
  try {
    now.mockReturnValue(10_000);
    ledger.recordViewerInput(surfaceId, "viewer");
    now.mockReturnValue(10_020);
    ledger.recordViewerInput(surfaceId, "viewer");
    // An edit's report can arrive after later input: only when it happened decides.
    expect(ledger.viewerInputAt(surfaceId, 10_005)).toEqual({
      consumerToken: "viewer",
      native: false,
    });
    expect(ledger.viewerInputAt(surfaceId, 9_999), "before any input").toBeNull();
    expect(ledger.viewerInputAt(surfaceId, 15_020), "past the activation lifetime").toBeNull();
    // An agent's command does not wait for the viewer's input, so an edit
    // after one, even with viewer input between, is nobody's for a while.
    now.mockReturnValue(10_030);
    ledger.recordAgentCommand(targetId);
    now.mockReturnValue(10_040);
    ledger.recordViewerInput(surfaceId, "viewer");
    expect(ledger.viewerInputAt(surfaceId, 10_045)).toBeNull();
    now.mockReturnValue(15_040);
    ledger.recordViewerInput(surfaceId, "viewer");
    expect(ledger.viewerInputAt(surfaceId, 15_041), "once the agent's command is old").toEqual({
      consumerToken: "viewer",
      native: false,
    });
    // Fast typing is still the person's: old input ages out without losing the window.
    now.mockReturnValue(16_000);
    for (let key = 0; key < 200; key++) {
      now.mockReturnValue(16_000 + key * 20);
      ledger.recordViewerInput(surfaceId, "viewer");
    }
    expect(ledger.viewerInputAt(surfaceId, 19_981)).toEqual({
      consumerToken: "viewer",
      native: false,
    });
    // A window the capped timeline no longer covers is nobody's: it could have held an agent.
    now.mockReturnValue(20_000);
    ledger.recordAgentCommand(targetId);
    for (let key = 1; key <= 1_024; key++) ledger.recordViewerInput(surfaceId, "viewer");
    expect(ledger.viewerInputAt(surfaceId, 20_001)).toBeNull();
    now.mockReturnValue(25_100);
    ledger.recordViewerInput(surfaceId, "viewer");
    expect(ledger.viewerInputAt(surfaceId, 25_101), "once the lost window is old").toEqual({
      consumerToken: "viewer",
      native: false,
    });
    // Input that names no viewer is nobody's.
    now.mockReturnValue(25_150);
    ledger.recordViewerInput(surfaceId, null);
    expect(ledger.viewerInputAt(surfaceId, 25_151)).toBeNull();
  } finally {
    now.mockRestore();
    await ledger.close();
  }
});
