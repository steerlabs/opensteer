const { createHash } = require("node:crypto");
const childProcess = require("node:child_process");
const { lstatSync, readFileSync, realpathSync } = require("node:fs");
const { join } = require("node:path");

function verifyIphoneBridgeRelease(directory, { architecture, release, teamId }) {
  const read = (file, executable = false) => {
    const stat = lstatSync(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      realpathSync(file) !== file ||
      (executable && ((stat.mode & 0o111) === 0 || stat.size > 128 * 1024 * 1024))
    )
      throw new Error("iPhone bridge resource must be a regular file.");
    return readFileSync(file);
  };
  const binary = join(directory, "opensteer-iphone-bridge");
  const bytes = read(binary, true);
  const manifest = JSON.parse(read(join(directory, "release.json")).toString("utf8"));
  if (
    !manifest ||
    Array.isArray(manifest) ||
    JSON.stringify(Object.keys(manifest).sort()) !==
      JSON.stringify([
        "architecture",
        "binarySha256",
        "operatingSystem",
        "protocolVersion",
        "schemaVersion",
      ]) ||
    manifest.schemaVersion !== 1 ||
    manifest.operatingSystem !== "darwin" ||
    manifest.protocolVersion !== 1 ||
    !["arm64", "amd64"].includes(architecture) ||
    manifest.architecture !== architecture ||
    manifest.binarySha256 !== createHash("sha256").update(bytes).digest("hex") ||
    bytes.length < 32 ||
    bytes.readUInt32LE(0) !== 0xfeedfacf ||
    bytes.readUInt32LE(4) !== (architecture === "arm64" ? 0x0100000c : 0x01000007)
  )
    throw new Error("iPhone bridge release manifest, digest or architecture is invalid.");
  if (release) {
    if (!/^[A-Z0-9]{10}$/u.test(teamId ?? ""))
      throw new Error("iPhone bridge requires a release Team ID.");
    const run = (file, args, input) =>
      childProcess.execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
        maxBuffer: 65536,
        input,
      });
    run("/usr/bin/codesign", [
      "--verify",
      "--strict",
      "-R",
      `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and identifier "com.opensteer.iphone-bridge" and certificate leaf[subject.OU] = "${teamId}" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists`,
      binary,
    ]);
    // codesign descriptions are emitted on stderr, even on success.
    const detail = childProcess.spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", binary], {
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 65536,
    });
    if (detail.error) throw detail.error;
    const description = `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
    if (
      detail.status !== 0 ||
      !description.split(/\r?\n/u).includes("Identifier=com.opensteer.iphone-bridge") ||
      !description.split(/\r?\n/u).includes(`TeamIdentifier=${teamId}`) ||
      !/^Authority=Developer ID Application:/mu.test(description) ||
      !/^CodeDirectory .* flags=.*\(runtime\)/mu.test(description) ||
      !/^Timestamp=.+/mu.test(description)
    )
      throw new Error("iPhone bridge must carry its Developer ID, hardened runtime and timestamp.");
    const xml = run("/usr/bin/codesign", ["-d", "--entitlements", "-", "--xml", binary]).trim();
    if (
      xml &&
      Object.keys(JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], xml)))
        .length
    )
      throw new Error("iPhone bridge must carry no entitlements.");
  }
  return manifest;
}
module.exports = { verifyIphoneBridgeRelease };
