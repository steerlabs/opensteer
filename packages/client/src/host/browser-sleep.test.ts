import { describe, expect, it } from "vitest";
import { browserSleepScenes, mockBrowserPoolReport } from "../mock/browser-sleep-fixtures.js";
import {
  BrowserRestartUnavailable,
  BrowserReturnNotes,
  browserRestartFailure,
  browserNotPooled,
  browserSleepFromHome,
  browserSleepWords,
  browserStartFailure,
  browserTabNote,
  browserWakeLine,
  restartPooledBrowser,
  type BrowserSleep,
  type BrowserSleepView,
} from "./browser-sleep.js";

const computer = "rnr_cloud";
const tab = "srf_page";
const since = "2026-11-20T09:00:00.000Z";
const startAt = "2026-11-20T08:59:57.000Z";
const view = (scene: (typeof browserSleepScenes)[number]) =>
  browserSleepFromHome([mockBrowserPoolReport(scene, computer, tab, since)], computer, tab);

describe("the mapping from the Home's report", () => {
  it("is not pooled for every Home that reports nothing, which is every Home today", () => {
    expect(browserSleepFromHome(undefined, computer, tab)).toBe(browserNotPooled);
    expect(browserSleepFromHome([], computer, tab)).toBe(browserNotPooled);
    expect(browserSleepFromHome(undefined, null, tab)).toBe(browserNotPooled);
    // Another Cloud Computer's report says nothing about this computer's browser.
    expect(
      browserSleepFromHome([mockBrowserPoolReport("waking", "rnr_other", tab)], computer, tab),
    ).toBe(browserNotPooled);
  });

  it("maps every scene to exactly one state", () => {
    const awake: BrowserSleep = { kind: "awake", computerId: computer };
    const expected: Record<(typeof browserSleepScenes)[number], BrowserSleepView> = {
      awake: { browser: awake, tab: { kind: "kept" } },
      asleep: { browser: { kind: "asleep", computerId: computer }, tab: { kind: "kept" } },
      waking: { browser: { kind: "waking", computerId: computer, since }, tab: { kind: "kept" } },
      starting: {
        browser: { kind: "starting", computerId: computer, since, reason: "expired" },
        tab: { kind: "kept" },
      },
      "starting-update": {
        browser: { kind: "starting", computerId: computer, since, reason: "update" },
        tab: { kind: "kept" },
      },
      restarting: {
        browser: { kind: "restarting", computerId: computer, since },
        tab: { kind: "kept" },
      },
      failed: {
        browser: { kind: "failed", computerId: computer, since, repeated: false },
        tab: { kind: "kept" },
      },
      "failed-again": {
        browser: { kind: "failed", computerId: computer, since, repeated: true },
        tab: { kind: "kept" },
      },
      reloaded: {
        browser: awake,
        tab: { kind: "reloaded", typed: false, reason: "expired", startAt },
      },
      "reloaded-typed": {
        browser: awake,
        tab: { kind: "reloaded", typed: true, reason: "expired", startAt },
      },
      "reloaded-by-you": {
        browser: awake,
        tab: { kind: "reloaded", typed: false, reason: "person", startAt },
      },
      "reloaded-security": {
        browser: awake,
        tab: { kind: "reloaded", typed: true, reason: "security-update", startAt },
      },
      lost: { browser: awake, tab: { kind: "lost", typed: false, startAt } },
      "lost-typed": { browser: awake, tab: { kind: "lost", typed: true, startAt } },
    };
    for (const scene of browserSleepScenes) expect(view(scene), scene).toEqual(expected[scene]);
  });

  it("keeps a tab the report does not name exactly as it was", () => {
    expect(
      browserSleepFromHome([mockBrowserPoolReport("reloaded", computer, tab)], computer, "other")
        .tab,
    ).toEqual({ kind: "kept" });
  });

  it("treats a browser preparing to sleep as awake", () => {
    expect(
      browserSleepFromHome([{ runnerId: computer, phase: "preparing", since }], computer, tab)
        .browser,
    ).toEqual({ kind: "awake", computerId: computer });
  });
});

describe("the line while a person waits", () => {
  const waking = view("waking").browser;
  const starting = view("starting").browser;
  const restarting = view("restarting").browser;
  const at = (browser: BrowserSleep, ms: number, picture: boolean, refused = false) =>
    browserWakeLine(browser, ms, { picture, refused });

  it("shows nothing at all for a wake under the quiet moment", () => {
    for (const ms of [0, 100, 399]) {
      expect(at(waking, ms, true)).toBeNull();
      expect(at(waking, ms, false)).toBeNull();
    }
  });

  it("then one calm line that changes as the wait grows, with a picture", () => {
    expect(at(waking, 400, true)).toEqual({ text: "Last picture", dimNow: false });
    expect(at(waking, 1_999, true)).toEqual({ text: "Last picture", dimNow: false });
    expect(at(waking, 2_000, true)?.text).toBe("Last picture · Waking browser…");
    expect(at(waking, 8_000, true)?.text).toBe("Last picture · Taking longer than usual…");
    expect(at(waking, 120_000, true)?.text).toBe("Last picture · Taking longer than usual…");
  });

  it("and without a picture", () => {
    expect(at(waking, 400, false)?.text).toBe("Opening…");
    expect(at(waking, 2_000, false)?.text).toBe("Waking browser…");
    expect(at(waking, 8_000, false)?.text).toBe("Taking longer than usual…");
  });

  it("dims an old picture at once before a fresh start, whose pages will not match it", () => {
    expect(at(starting, 0, true)).toEqual({
      text: "Last picture · Starting browser…",
      dimNow: true,
    });
    expect(at(starting, 0, false)).toBeNull();
    expect(at(starting, 400, false)).toEqual({ text: "Starting browser…", dimNow: true });
    expect(at(starting, 8_000, true)?.text).toBe("Last picture · Taking longer than usual…");
  });

  it("answers a restart the person asked for at once", () => {
    expect(at(restarting, 0, false)).toEqual({ text: "Restarting browser…", dimNow: true });
    expect(at(restarting, 0, true)?.text).toBe("Last picture · Restarting browser…");
    expect(at(restarting, 9_000, false)?.text).toBe("Taking longer than usual…");
  });

  it("says plainly that a tap or key on the waiting picture was not sent", () => {
    // Even inside the quiet moment: the person acted, so the picture answers.
    expect(at(waking, 100, true, true)?.text).toBe("Not sent · Waking browser…");
    expect(at(waking, 9_000, true, true)?.text).toBe("Not sent · Taking longer than usual…");
    expect(at(starting, 0, true, true)?.text).toBe("Not sent · Starting browser…");
  });

  it("shows nothing for a browser that is awake, asleep, failed, or not pooled", () => {
    for (const scene of ["awake", "asleep", "failed", "reloaded"] as const)
      expect(at(view(scene).browser, 10_000, true, true)).toBeNull();
    expect(at(browserNotPooled.browser, 10_000, true, true)).toBeNull();
  });
});

describe("the note a tab says once", () => {
  it("says a reloaded page reloaded, and asks to check typing only when there was some", () => {
    expect(browserTabNote(view("reloaded").tab)).toEqual({
      title: "This page reloaded",
      detail: "Your browser restarted.",
      line: "This page reloaded because your browser restarted.",
    });
    expect(browserTabNote(view("reloaded-typed").tab)).toEqual({
      title: "This page reloaded",
      detail: "Your browser restarted, so text you hadn’t sent may be gone.",
      line: "This page reloaded because your browser restarted. Check anything you were typing.",
    });
    expect(browserTabNote(view("reloaded-by-you").tab)?.line).toBe(
      "This page reloaded because you restarted your browser.",
    );
  });

  it("names a security update that could not wait, once", () => {
    const security = view("reloaded-security").tab;
    expect(browserTabNote(security)?.line).toBe(
      "This page reloaded because your browser restarted for a security update. Check anything you were typing.",
    );
    expect(browserTabNote(security, { reasonSaid: true })?.line).toBe(
      "This page reloaded because your browser restarted. Check anything you were typing.",
    );
  });

  it("tells a page that could not be restored apart from one that reloaded", () => {
    expect(browserTabNote(view("lost").tab)).toEqual({
      title: "This page couldn’t be restored",
      detail: "It didn’t come back as you left it. Reload to open it again.",
      line: "This page couldn’t be restored as you left it. Reload to open it again.",
    });
    expect(browserTabNote(view("lost-typed").tab)?.line).toBe(
      "This page couldn’t be restored, and text you hadn’t sent is gone. Reload to open it again.",
    );
    expect(browserTabNote({ kind: "kept" })).toBeNull();
  });

  it("leaves once seen, and gives a start's reason in only the first note seen", () => {
    const notes = new BrowserReturnNotes();
    const first = view("reloaded-security").tab;
    const second = browserSleepFromHome(
      [
        {
          ...mockBrowserPoolReport("reloaded-security", computer, tab),
          pages: [{ surfaceId: "srf_second", outcome: "reloaded", typed: false }],
        },
      ],
      computer,
      "srf_second",
    ).tab;
    expect(notes.note(computer, "srf_second", second)?.line).toContain("security update");
    expect(notes.note(computer, tab, first)?.line).toContain("security update");
    let changes = 0;
    notes.subscribe(() => changes++);
    notes.seen(computer, tab, first);
    notes.seen(computer, tab, first);
    expect(changes).toBe(1);
    expect(notes.note(computer, tab, first)).toBeNull();
    expect(notes.note(computer, "srf_second", second)?.line).toBe(
      "This page reloaded because your browser restarted.",
    );
    // A later start is a new note.
    const later = { ...first, startAt: "2026-11-21T08:00:00.000Z" };
    expect(notes.note(computer, tab, later)?.line).toContain("security update");
  });
});

describe("a browser that could not start", () => {
  it("keeps tabs and sign-ins, and points to support from the second failure", () => {
    expect(browserStartFailure(view("failed").browser)).toEqual({
      title: "Your browser couldn’t start",
      detail: "Your tabs and sign-ins are kept. Try again in a moment.",
      contactSupport: false,
    });
    expect(browserStartFailure(view("failed-again").browser)).toEqual({
      title: "Your browser couldn’t start",
      detail: "Your tabs and sign-ins are kept. If this keeps happening, contact support.",
      contactSupport: true,
    });
    expect(browserStartFailure(view("waking").browser)).toBeNull();
  });
});

describe("Restart browser", () => {
  it("is refused, plainly, until the Home supports it", async () => {
    await expect(restartPooledBrowser({}, computer)).rejects.toBeInstanceOf(
      BrowserRestartUnavailable,
    );
    await expect(restartPooledBrowser({}, computer)).rejects.toThrow(
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    );
  });

  it("says exactly what it does before it does it", () => {
    expect(browserSleepWords.restartBody).toBe(
      "Every page in your Cloud Computer’s browser closes and opens again from its address. Your tabs and sign-ins stay. Anything typed and not sent may be lost.",
    );
  });
});

describe("the words", () => {
  const every = [
    ...Object.values(browserSleepWords),
    ...browserSleepScenes.flatMap((scene) => {
      const note = browserTabNote(view(scene).tab);
      const failure = browserStartFailure(view(scene).browser);
      return [
        ...(note ? [note.title, note.detail, note.line] : []),
        ...(failure ? [failure.title, failure.detail] : []),
      ];
    }),
  ];

  it("never say what an agent can or cannot see, and never promise more than is true", () => {
    for (const words of every) {
      expect(words).not.toMatch(/password|card|agent can|agent cannot|can’t see|cannot see/iu);
      expect(words).not.toMatch(/instantly|never reloads|always exactly|stays signed in|%/iu);
      expect(words).not.toMatch(/snapshot|micro-?VM|pool|cold start|park/iu);
    }
  });
});

describe("a restart that did not happen", () => {
  it("says so in fixed words, never the failure's own text", () => {
    expect(browserRestartFailure(new BrowserRestartUnavailable())).toBe(
      "Your Cloud Computer can’t restart its browser yet. Nothing was changed.",
    );
    expect(browserRestartFailure(new Error("socket hang up ECONNRESET"))).toBe(
      "Your browser wasn’t restarted. Try again in a moment.",
    );
  });
});

describe("a second loss of the same tab", () => {
  it("is a new note, shown and told to the Home, even with no new start", async () => {
    const told: string[] = [];
    const notes = new BrowserReturnNotes(async (_computer, _tab, noticeId) => {
      told.push(noticeId);
    });
    const lost = (noticeId: string) =>
      ({ kind: "lost", typed: false, startAt: null, noticeId }) as const;
    expect(notes.note(computer, tab, lost("id-1"))).not.toBeNull();
    notes.seen(computer, tab, lost("id-1"));
    expect(notes.note(computer, tab, lost("id-1"))).toBeNull();
    // A later loss of the same tab has its own notice: it is shown, and its seen is sent.
    expect(notes.note(computer, tab, lost("id-2"))).not.toBeNull();
    notes.seen(computer, tab, lost("id-2"));
    expect(told).toEqual(["id-1", "id-2"]);
  });
});
