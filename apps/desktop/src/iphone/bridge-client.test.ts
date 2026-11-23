import { iphoneNativeHelloSchema, iphoneBridgeBounds } from "@opensteer/protocol/iphone-bridge";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SupervisedProcess } from "@opensteer/harness/process-supervisor";
import {
  encodeLengthPrefixedJson,
  LengthPrefixedJsonReader,
} from "@opensteer/shared/lengthPrefixedJson";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { IphoneBridgeClient } from "./bridge-client.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function fake() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const exit = Promise.withResolvers<{ code: number; signal: null }>();
  const owned = { pid: 123, stdin } as unknown as ChildProcessWithoutNullStreams;
  const terminate = vi.fn(async () => {
    stdin.destroy();
    stdout.end();
    stderr.end();
    exit.resolve({ code: 0, signal: null });
  });
  const client = new IphoneBridgeClient({
    child: owned,
    stdout,
    stderr,
    exited: exit.promise,
    terminate,
  } satisfies SupervisedProcess);
  cleanups.push(() => client.close());
  const reader = new LengthPrefixedJsonReader(262144);
  const requests: { id: number; method: string }[] = [];
  stdin.on("data", (chunk: Buffer) => {
    for (const value of reader.push(chunk))
      requests.push(z.object({ id: z.number(), method: z.string() }).parse(value));
  });
  const reply = (value: unknown) => stdout.write(encodeLengthPrefixedJson(value, 2097152));
  return { client, requests, stdout, terminate, reply };
}
it("bounds the pending map and tears down only its captured supervisor", async () => {
  const f = fake();
  const requests = Array.from({ length: 63 }, () =>
    f.client.request("roster.get", {}, z.strictObject({})).catch((error: unknown) => error),
  );
  await expect(f.client.request("roster.get", {}, z.strictObject({}))).rejects.toMatchObject({
    code: "phone-in-use",
  });
  await f.client.close();
  await Promise.all(requests);
  expect(f.requests).toHaveLength(63);
  expect(f.terminate).toHaveBeenCalledExactlyOnceWith(5000);
});
it("rejects malformed UTF-8 without logging content and classifies sent effects unknown", async () => {
  const f = fake();
  const result = f.client.request("phone.perform", {}, z.strictObject({}));
  f.stdout.write(Buffer.from([0, 0, 0, 1, 0xff]));
  await expect(result).rejects.toMatchObject({ code: "phone-disconnected", effect: "unknown" });
});
it("validates every method's result and never resends an invalid reply", async () => {
  const f = fake();
  const result = f.client.request("roster.get", {}, z.strictObject({ revision: z.number() }));
  f.reply({ kind: "response", id: 1, result: { udid: "synthetic-private-phone" } });
  await expect(result).rejects.toMatchObject({ code: "protocol-unsupported" });
  expect(f.requests).toHaveLength(1);
});

it("routes display events and recovers a sequence gap with a clean roster event", async () => {
  const f = fake();
  const hello = f.client.request("hello", {}, iphoneNativeHelloSchema);
  f.reply({
    kind: "response",
    id: 1,
    result: {
      bridge: "opensteer-iphone-bridge",
      version: "0.1.0",
      protocolVersion: 1,
      bootId: "boot",
      bounds: iphoneBridgeBounds,
    },
  });
  await hello;
  const gap = vi.fn();
  const lost = vi.fn();
  const events: unknown[] = [];
  f.client.onGap(gap);
  f.client.onLost(lost);
  f.client.onEvent((event) => events.push(event));
  f.reply({
    kind: "event",
    bootId: "boot",
    sequence: 2,
    event: "display.state",
    displayState: {
      streamId: "dsp_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      state: "protected",
      generation: 1,
      width: 0,
      height: 0,
      rotation: 0,
    },
  });
  await vi.waitFor(() => expect(f.requests.at(-1)?.method).toBe("roster.get"), { timeout: 1000 });
  f.reply({ kind: "response", id: 2, result: { revision: 2, candidates: [] } });
  await vi.waitFor(() => expect(events).toHaveLength(2), { timeout: 1000 });
  expect(events).toMatchObject([
    { event: "display.state", displayState: { state: "protected" } },
    { event: "roster.changed", roster: { revision: 2, candidates: [] } },
  ]);
  expect(events[1]).not.toHaveProperty("displayState");
  expect(gap).toHaveBeenCalledTimes(1);
  expect(lost).not.toHaveBeenCalled();
  expect(f.requests.map(({ method }) => method)).toEqual(["hello", "roster.get"]);
});
