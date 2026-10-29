import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../apps/desktop/native/computer-use/Tests");
// OwnerSampleFence.start() only advances a generation under a lock, so it is the one start
// allowed. The exception matches the name: don't call any other startable value `fence`.
const forbidden =
  /AccessibilityCalls\.live|TestProcessApp|SyntheticEvents\.|HelperRuntime\.start|(?<!\bfence)\.start\s*\(|FocusEnforcer\s*\(|PrivateAPI\.postToPid/;

const allowedSupportWrappers = new Set([
  "func startQueuedWork(_ work: QueuedWork) -> Bool { work.start() }",
  "func startIPCServer(_ server: IPCServer) throws { try server.start() }",
]);

function violationsIn(file: string, source: string): string[] {
  return source.split("\n").flatMap((line, index) => {
    if (!forbidden.test(line)) return [];
    if (
      file === "ComputerUseTestSupport/HostFakes.swift" &&
      allowedSupportWrappers.has(line.trim())
    )
      return [];
    return [`${file}:${index + 1}: ${line.trim()}`];
  });
}

it("keeps the host computer-use tests and support away from live effects", () => {
  const violations = ["ComputerUseCoreTests", "ComputerUseTestSupport"].flatMap((directory) =>
    readdirSync(path.join(root, directory), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".swift"))
      .flatMap((file) =>
        violationsIn(
          `${directory}/${file}`,
          readFileSync(path.join(root, directory, file), "utf8"),
        ),
      ),
  );
  expect(violations).toEqual([]);
});

it("rejects live effects in support except the exact host-safe wrappers", () => {
  const file = "ComputerUseTestSupport/HostFakes.swift";
  for (const wrapper of allowedSupportWrappers) {
    expect(violationsIn(file, wrapper)).toEqual([]);
    expect(violationsIn("ComputerUseTestSupport/Other.swift", wrapper)).toHaveLength(1);
    expect(violationsIn(file, wrapper.replace(" }", "; HelperRuntime.start() }"))).toHaveLength(1);
  }
  expect(violationsIn(file, "runtime.start()")).toEqual([`${file}:1: runtime.start()`]);
  expect(violationsIn("ComputerUseCoreTests/Owner.swift", "let next = fence.start()")).toEqual([]);
});

const globalInputPost =
  /\bCGEventTapPostEvent\b|\btapPostEvent\b|\bCGEventPost\b|\.post\s*\(\s*tap\s*:|CGEvent\.post\s*\(/;
it("addresses agent input only to the target process (Invariant 4)", () => {
  const sources = path.resolve(root, "../Sources");
  const violations = readdirSync(sources, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".swift"))
    .filter((file) =>
      globalInputPost.test(
        readFileSync(path.join(sources, file), "utf8")
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("//"))
          .join("\n"),
      ),
    );
  expect(violations).toEqual([]);
});
it.each([
  "CGEventPost(.cghidEventTap, event)",
  "CGEventTapPostEvent(proxy, event)",
  "CGEvent.tapPostEvent(proxy, event: event)",
  "event.tapPostEvent(proxy)",
  "event.post(tap: .cghidEventTap)",
  "CGEvent.post(event)",
  "event.post(\n  tap: .cghidEventTap)",
])("rejects global input posting: %s", (source) => {
  expect(globalInputPost.test(source)).toBe(true);
});

it("permits process-addressed posting", () => {
  expect(globalInputPost.test("CGEventPostToPid(pid, event)")).toBe(false);
  expect(globalInputPost.test("PrivateAPI.postToPid(pid, event)")).toBe(false);
});
