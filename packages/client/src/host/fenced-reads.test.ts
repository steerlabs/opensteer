import { afterEach, expect, it, vi } from "vitest";
import { HostClientRequestError } from "./client.js";
import { FencedReads, type FencedRead } from "./fenced-reads.js";

afterEach(() => vi.useRealTimers());

/** A read the test answers by hand, recording what it was allowed to install. */
function harness(epoch = () => "1") {
  const reads = new FencedReads({ epoch });
  const answers: { read: FencedRead; resolve(): void; reject(error: unknown): void }[] = [];
  const installed: number[] = [];
  const job = (value: number) => async (read: FencedRead) => {
    await new Promise<void>((resolve, reject) => answers.push({ read, resolve, reject }));
    if (read.current()) installed.push(value);
  };
  const settle = async () => {
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  return { reads, answers, installed, job, settle };
}

const busy = () =>
  new HostClientRequestError({
    code: "unavailable",
    message: "Busy",
    retryable: true,
    status: 503,
  });

it("installs only while the token it started with is current", async () => {
  let epoch = "1";
  const { reads, answers, installed, job, settle } = harness(() => epoch);
  void reads.request("queue", job(1));
  await settle();
  // A repair moved the epoch while the read flew.
  epoch = "2";
  answers[0]!.resolve();
  await settle();
  expect(installed).toEqual([]);
});

it("runs one read per key; a change or newer need while it flies runs it again once it lands", async () => {
  const { reads, answers, installed, job, settle } = harness();
  const first = reads.request("overlay", job(1));
  const second = reads.request("overlay", job(2));
  await settle();
  expect(answers).toHaveLength(1);
  answers[0]!.resolve();
  await settle();
  // The superseded result never installs; the newest need runs.
  expect(answers).toHaveLength(2);
  reads.changed("overlay");
  answers[1]!.resolve();
  await settle();
  expect(answers).toHaveLength(3);
  answers[2]!.resolve();
  await Promise.all([first, second]);
  expect(installed).toEqual([2]);
});

it("retries a failed read with backoff while observed, and stops when it is not", async () => {
  vi.useFakeTimers();
  const { reads, answers, installed, job, settle } = harness();
  let observed = true;
  void reads.request("requests", job(1), () => observed);
  await settle();
  answers[0]!.reject(busy());
  await settle();
  await vi.advanceTimersByTimeAsync(999);
  expect(answers).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(answers).toHaveLength(2);
  answers[1]!.reject(busy());
  await settle();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(answers).toHaveLength(3);
  answers[2]!.resolve();
  await settle();
  expect(installed).toEqual([1]);

  void reads.request("requests", job(2), () => observed);
  await settle();
  answers[3]!.reject(busy());
  await settle();
  observed = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(answers).toHaveLength(4);
  expect(reads.busy("requests")).toBe(false);
  // A refusal that will not change by trying again settles the request with it.
  const refused = reads.request("requests", async () => {
    throw new HostClientRequestError({ code: "not_found", message: "Gone", status: 404 });
  });
  await expect(refused).rejects.toThrow("Gone");
});

it("owns a multi-page read as one job that restarts from the first page after a repair", async () => {
  let epoch = "1";
  const reads = new FencedReads({ epoch: () => epoch });
  const pages: string[] = [];
  const answers: (() => void)[] = [];
  const list: number[] = [];
  const job = async (read: FencedRead) => {
    const held: number[] = [];
    for (let page = 0; page < 3; page++) {
      pages.push(`${epoch}:${page}`);
      await new Promise<void>((resolve) => answers.push(resolve));
      if (!read.current()) return;
      held.push(page);
      list.splice(0, list.length, ...held);
    }
  };
  const done = reads.request("tasks", job);
  await Promise.resolve();
  answers.shift()!();
  await vi.waitFor(() => expect(answers).toHaveLength(1));
  epoch = "2";
  reads.restart();
  answers.shift()!();
  for (let page = 0; page < 3; page++) {
    await vi.waitFor(() => expect(answers.length, "the next page was never read").toBe(1));
    answers.shift()!();
  }
  await done;
  expect(pages).toEqual(["1:0", "1:1", "2:0", "2:1", "2:2"]);
  expect(list).toEqual([0, 1, 2]);
});

it("installs nothing after the key stops or the owner is disposed", async () => {
  const { reads, answers, installed, job, settle } = harness();
  void reads.request("assignments", job(1));
  void reads.request("history", job(2));
  await settle();
  reads.stop("assignments");
  reads.dispose();
  for (const answer of answers) answer.resolve();
  await settle();
  expect(installed).toEqual([]);
  expect(answers.every(({ read }) => read.signal.aborted)).toBe(true);
});
