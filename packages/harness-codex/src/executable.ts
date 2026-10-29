import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const codexTriples = {
  darwin: {
    arm64: "aarch64-apple-darwin",
    x64: "x86_64-apple-darwin",
  },
  linux: {
    arm64: "aarch64-unknown-linux-musl",
    x64: "x86_64-unknown-linux-musl",
  },
  win32: {
    arm64: "aarch64-pc-windows-msvc",
    x64: "x86_64-pc-windows-msvc",
  },
} as const;

export function packagedCodexExecutable(): string {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(`Codex does not provide a binary for ${process.platform}-${process.arch}`);
  }
  if (
    process.platform !== "darwin" &&
    process.platform !== "linux" &&
    process.platform !== "win32"
  ) {
    throw new Error(`Codex does not provide a binary for ${process.platform}-${process.arch}`);
  }

  const localRequire = createRequire(import.meta.url);
  const codexPackage = localRequire.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackage);
  const platformPackage = codexRequire.resolve(
    `@openai/codex-${process.platform}-${process.arch}/package.json`,
  );
  const triple = codexTriples[process.platform][process.arch];
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  return join(dirname(platformPackage), "vendor", triple, "bin", executable);
}
