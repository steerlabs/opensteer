import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { buildSwiftProducts } from "./build-swift-products.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn((_command, args: string[]) =>
    args.includes("--show-bin-path")
      ? `/pkg/.build/${args[args.indexOf("--arch") + 1]}/release\n`
      : "",
  ),
}));
vi.mock("node:fs", () => ({ mkdirSync: vi.fn() }));
it("builds each slice with plain SwiftPM and joins the per-architecture product paths", () => {
  const output = buildSwiftProducts("/pkg", ["Broker", "Worker"], ["arm64", "x86_64"]);
  const calls = vi.mocked(execFileSync).mock.calls;
  const swift = calls.filter(([command]) => command === "/usr/bin/swift");
  expect(swift).toHaveLength(6);
  for (const [, args] of swift) {
    expect(args!.filter((arg) => arg === "--arch")).toHaveLength(1);
    expect(args).toContain("release");
    expect(args).toContain("--build-system");
    expect(args).toContain("native");
  }
  expect(output).toBe("/pkg/.build/universal/release");
  expect(mkdirSync).toHaveBeenCalledWith(output, { recursive: true });
  for (const product of ["Broker", "Worker"])
    expect(execFileSync).toHaveBeenCalledWith(
      "/usr/bin/lipo",
      [
        "-create",
        `/pkg/.build/arm64/release/${product}`,
        `/pkg/.build/x86_64/release/${product}`,
        "-output",
        `${output}/${product}`,
      ],
      { stdio: "inherit" },
    );
});
