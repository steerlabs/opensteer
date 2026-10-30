import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** One --arch keeps SwiftPM on its native build system, including embedded resources. */
export function buildSwiftProducts(
  directory: string,
  products: readonly string[],
  architectures: readonly string[],
  configuration = "release",
  extraFlags: readonly string[] = [],
): string {
  const bins = architectures.map((architecture) => {
    const flags = [
      "build",
      ...(architectures.length > 1 ? ["--build-system", "native"] : []),
      "--package-path",
      directory,
      "-c",
      configuration,
      "--arch",
      architecture,
      ...extraFlags,
    ];
    for (const product of products)
      execFileSync("/usr/bin/swift", [...flags, "--product", product], { stdio: "inherit" });
    return execFileSync("/usr/bin/swift", [...flags, "--show-bin-path"], {
      encoding: "utf8",
    }).trim();
  });
  if (bins.length === 1) return bins[0]!;
  const output = path.join(directory, ".build", "universal", configuration);
  mkdirSync(output, { recursive: true });
  for (const product of products)
    execFileSync(
      "/usr/bin/lipo",
      [
        "-create",
        ...bins.map((bin) => path.join(bin, product)),
        "-output",
        path.join(output, product),
      ],
      { stdio: "inherit" },
    );
  return output;
}
