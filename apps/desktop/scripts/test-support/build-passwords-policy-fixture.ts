import { execFileSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "../..");
const native = path.join(desktop, "native/passwords");
const flags = ["--package-path", native, "-c", "debug", "-Xswiftc", "-enable-testing"];
// These are library targets. No XCTest target is compiled or linked.
for (const target of ["PasswordsBrokerKit", "PasswordsTestSupport"])
  execFileSync("swift", ["build", ...flags, "--target", target], { stdio: "inherit" });
const binaryDirectory = execFileSync("swift", ["build", ...flags, "--show-bin-path"], {
  encoding: "utf8",
}).trim();
// SwiftPM's native build system keeps each target's objects and the modules
// in the bin directory; Swift Build (the default from Swift 6.3) keeps objects
// under Intermediates.noindex beside Products, per configuration, and the
// modules in the bin directory. Another configuration's objects may sit there
// too, so only this one's are taken.
const nativeLayout = existsSync(path.join(binaryDirectory, "Modules"));
const moduleDirectory = nativeLayout ? path.join(binaryDirectory, "Modules") : binaryDirectory;
const configuration = path.basename(binaryDirectory);
function objectDirectory(target: string): string {
  if (nativeLayout) return path.join(binaryDirectory, `${target}.build`);
  const intermediates = path.resolve(binaryDirectory, "../../Intermediates.noindex");
  const [directory, ...others] = globSync(`*/${configuration}/${target}-t.build/Objects-normal/*`, {
    cwd: intermediates,
  });
  if (!directory || others.length > 0)
    throw new Error(`Expected one object directory for ${target} in ${intermediates}`);
  return path.join(intermediates, directory);
}
// MacOSSigning is PasswordsBrokerKit's dependency package, built into the same directory.
const objects = [
  "PasswordsCore",
  "MacOSSigning",
  "PasswordsBrokerKit",
  "PasswordsTestSupport",
].flatMap((target) => {
  const directory = objectDirectory(target);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".o"))
    .map((name) => path.join(directory, name));
});
const executable = path.join(desktop, ".electron-smoke/passwords-policy-broker");
mkdirSync(path.dirname(executable), { recursive: true });
execFileSync(
  "swiftc",
  [
    "-parse-as-library",
    "-I",
    moduleDirectory,
    path.join(import.meta.dirname, "passwords-policy-broker.swift"),
    path.join(native, "Tests/PasswordsBrokerTests/Support/SoftwareOwnerKeys.swift"),
    ...objects,
    "-o",
    executable,
  ],
  { stdio: "inherit" },
);
execFileSync("codesign", ["--force", "--sign", "-", executable], { stdio: "inherit" });
