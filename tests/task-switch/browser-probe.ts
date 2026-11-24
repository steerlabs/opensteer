import type { createBrowserHostClient } from "../../apps/web/src/host/browser-host-client.js";

type Client = ReturnType<typeof createBrowserHostClient>;
type Reader = NonNullable<ReturnType<Client["getThreadTranscript"]>>;

export interface SwitchTarget {
  threadId: string;
  title: string;
  latestMessageId: string;
}

export interface BrowserSample {
  clickAt: number | null;
  firstPaintMs: number | null;
  latestPaintMs: number | null;
  synchronizedMs: number | null;
  transcriptNotifications: number;
  transcriptNotificationsThroughSync: number;
  hostNotifications: number;
  reactMarkdownParses: number | null;
}

let markdownParses: number | undefined;

export function enableReactMarkdownProbe() {
  markdownParses ??= 0;
}

export function recordReactMarkdownParse() {
  if (markdownParses !== undefined) markdownParses++;
}

declare global {
  interface Window {
    taskSwitchProbe: {
      arm(target: SwitchTarget): void;
      read(): BrowserSample | null;
      finish(): BrowserSample & {
        endAt: number;
        longTasks: { startMs: number; durationMs: number }[];
      };
      live(threadId: string, messageId: string): boolean;
      openLatestWindow(threadId: string): Promise<boolean>;
      connection(): ReturnType<Client["connection"]["getSnapshot"]>;
      describeWindow(
        threadId: string,
        reportIds: readonly string[],
      ): { entries: number; toolEntries: number; hasReports: boolean };
    };
  }
}

function hasCurrentReply(reader: Reader | undefined, messageId: string) {
  const state = reader?.getSnapshot();
  return Boolean(state?.synchronized && state.entries.some(({ id }) => id === messageId));
}

function intersectsTranscript(row: HTMLElement, clip: DOMRect) {
  const rect = row.getBoundingClientRect();
  return (
    rect.height > 0 &&
    rect.width > 0 &&
    rect.bottom > Math.max(0, clip.top) &&
    rect.top < Math.min(innerHeight, clip.bottom) &&
    rect.right > Math.max(0, clip.left) &&
    rect.left < Math.min(innerWidth, clip.right) &&
    getComputedStyle(row).visibility === "visible" &&
    Boolean(row.textContent?.trim())
  );
}

function visibleTranscript(target: SwitchTarget, lookForFirst: boolean) {
  const header = document.querySelector(".conv-header h1");
  if (header?.textContent?.trim() !== target.title) return { first: false, latest: false };
  const scroller = header.closest(".thread")?.querySelector(".transcript-scroll");
  const log = scroller?.querySelector('[role="log"]');
  if (!scroller || !log) return { first: false, latest: false };
  const clip = scroller.getBoundingClientRect();
  const reply = log.querySelector<HTMLElement>(
    `[data-message-id="${CSS.escape(target.latestMessageId)}"]`,
  );
  const latest = reply !== null && intersectsTranscript(reply, clip);
  const first =
    latest ||
    (lookForFirst &&
      Array.from(log.querySelectorAll<HTMLElement>("[data-transcript-row]")).some((row) =>
        intersectsTranscript(row, clip),
      ));
  return { first, latest };
}

// The instrumented bundle uses the ordinary app entry. Observe the real client's public
// reader without acquiring an interest in the task or reading resource-backed Host fields.
export function installTaskSwitchProbe(client: Client) {
  let armed: SwitchTarget | undefined;
  let active: BrowserSample | undefined;
  let observed: Reader | undefined;
  let release: (() => void) | undefined;
  let started = 0;
  let parsesAtClick = 0;
  const longTasks: PerformanceEntry[] = [];
  const observer = new PerformanceObserver((list) => longTasks.push(...list.getEntries()));
  if (!PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    throw new Error("This benchmark requires Chromium long-task timing.");
  }
  observer.observe({ entryTypes: ["longtask"] });

  const watch = () => {
    if (!active || active.clickAt === null || !armed) return;
    const reader = client.getThreadTranscript(armed.threadId);
    if (reader === observed) return;
    release?.();
    observed = reader;
    const sample = active;
    const target = armed;
    const check = () => {
      if (sample.synchronizedMs === null && hasCurrentReply(reader, target.latestMessageId)) {
        sample.synchronizedMs = performance.now() - started;
        sample.transcriptNotificationsThroughSync = sample.transcriptNotifications;
      }
    };
    release = reader?.subscribe(() => {
      sample.transcriptNotifications++;
      check();
    });
    check();
  };

  const activate = client.activateThread.bind(client);
  client.activateThread = (id) => {
    activate(id);
    watch();
  };
  const observe = client.observeThread.bind(client);
  client.observeThread = (id) => {
    const unsubscribe = observe(id);
    watch();
    return unsubscribe;
  };
  client.subscribe(() => {
    if (active?.clickAt != null) active.hostNotifications++;
  });

  window.addEventListener(
    "click",
    (event) => {
      if (!armed || !active || active.clickAt !== null || !(event.target instanceof Element))
        return;
      const task = event.target.closest(".side-task[data-thread-id]");
      if (task?.getAttribute("data-thread-id") !== armed.threadId) return;
      const sample = active;
      const target = armed;
      started = performance.mark("task-switch-selection").startTime;
      sample.clickAt = performance.timeOrigin + started;
      parsesAtClick = markdownParses ?? 0;
      watch();
      let previousFrame: { first: boolean; latest: boolean } | undefined;
      const frame = () => {
        if (sample !== active) return;
        const now = performance.now();
        // A visible sample in the preceding animation frame had a rendering opportunity.
        if (previousFrame?.first && sample.firstPaintMs === null)
          sample.firstPaintMs = now - started;
        if (previousFrame?.latest && sample.latestPaintMs === null)
          sample.latestPaintMs = now - started;
        if (sample.latestPaintMs !== null && sample.firstPaintMs !== null) return;
        previousFrame = visibleTranscript(target, sample.firstPaintMs === null);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    { capture: true },
  );

  window.taskSwitchProbe = {
    arm(target) {
      release?.();
      release = undefined;
      observed = undefined;
      armed = target;
      performance.clearMarks("task-switch-selection");
      longTasks.length = 0;
      observer.takeRecords();
      active = {
        clickAt: null,
        firstPaintMs: null,
        latestPaintMs: null,
        synchronizedMs: null,
        transcriptNotifications: 0,
        transcriptNotificationsThroughSync: 0,
        hostNotifications: 0,
        reactMarkdownParses: null,
      };
    },
    read: () => active ?? null,
    finish() {
      if (!active?.clickAt) throw new Error("The task switch click was not recorded.");
      const ended = performance.now();
      const sample = active;
      active = undefined;
      release?.();
      release = undefined;
      longTasks.push(...observer.takeRecords());
      return {
        ...sample,
        endAt: performance.timeOrigin + ended,
        reactMarkdownParses: markdownParses === undefined ? null : markdownParses - parsesAtClick,
        longTasks: longTasks
          .filter(({ startTime, duration }) => startTime < ended && startTime + duration > started)
          .map(({ startTime, duration }) => ({
            startMs: startTime - started,
            durationMs: duration,
          })),
      };
    },
    connection: () => client.connection.getSnapshot(),
    async openLatestWindow(threadId) {
      const opened = await client.loadLatestTranscript(threadId);
      client.revealedTranscriptMove(threadId);
      return opened;
    },
    describeWindow(threadId, reportIds) {
      const entries = client.getThreadTranscript(threadId)?.getSnapshot().entries ?? [];
      const ids = new Set(entries.map(({ id }) => id));
      return {
        entries: entries.length,
        toolEntries: entries.filter(({ kind }) => kind === "tool").length,
        hasReports: reportIds.every((id) => ids.has(id)),
      };
    },
    live: (id, messageId) => hasCurrentReply(client.getThreadTranscript(id), messageId),
  };
}
