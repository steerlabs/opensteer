import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudComputerIdSchema } from "@opensteer/control-plane-protocol";
import { expect, it } from "vitest";
import { z } from "zod";
import { renderUserData } from "./boot.js";

const installer = 'printf "%s\\n" "$@" > "$MARKER"\n';
const spec = {
  cloudComputerId: CloudComputerIdSchema.parse("cc_00000000-0000-4000-8000-000000000001"),
  accountOrigin: "https://account.example.com",
  hostname: "home.example.com",
  installerUrl: "https://releases.example.com/installer.sh",
  installerSha256: createHash("sha256").update(installer).digest("hex"),
  bootstrapToken: "short_lived_token",
};
const config = z.strictObject({
  write_files: z.array(
    z.strictObject({
      path: z.string(),
      owner: z.literal("root:root"),
      permissions: z.literal("0600"),
      content: z.string(),
    }),
  ),
  runcmd: z.array(z.array(z.string())),
});
const userData = (text: string) => {
  expect(text.startsWith("#cloud-config\n")).toBe(true);
  return config.parse(JSON.parse(text.slice("#cloud-config\n".length)));
};

it("writes exactly the approved fields and excludes the token from installer arguments", () => {
  const input = { ...spec, databasePassword: "unrelated_secret", apiToken: "unrelated_api_secret" };
  const rendered = renderUserData(input);
  const parsed = userData(rendered);
  const { bootstrapToken, ...publicSpec } = spec;
  expect(parsed.write_files.slice(0, 2)).toEqual([
    {
      path: "/root/opensteer-home-boot.json",
      owner: "root:root",
      permissions: "0600",
      content: JSON.stringify(publicSpec),
    },
    {
      path: "/root/opensteer-home-bootstrap-token",
      owner: "root:root",
      permissions: "0600",
      content: bootstrapToken,
    },
  ]);
  expect(parsed.write_files[3]?.content).toContain("Restart=on-failure");
  expect(parsed.write_files[3]?.content).toContain(
    "ConditionPathExists=/root/opensteer-home-bootstrap-token",
  );
  expect(parsed.runcmd).toEqual([
    ["systemctl", "daemon-reload"],
    ["systemctl", "enable", "--now", "--no-block", "opensteer-home-download.service"],
  ]);
  expect(parsed.write_files[2]?.content).not.toContain(bootstrapToken);
  expect(rendered).not.toContain("unrelated_");
});

it.each([true, false])("runs the installer only when the digest matches (%s)", (valid) => {
  const temp = mkdtempSync(join(tmpdir(), "opensteer-home-boot-"));
  try {
    const marker = join(temp, "ran");
    const token = join(temp, "opensteer-home-bootstrap-token");
    const body = join(temp, "download");
    writeFileSync(body, installer);
    writeFileSync(token, spec.bootstrapToken);
    writeFileSync(
      join(temp, "curl"),
      `#!/bin/sh
while [ "$1" != --output ]; do shift; done
cp "$DOWNLOAD" "$2"
`,
      { mode: 0o700 },
    );
    const hash = valid ? spec.installerSha256 : "0".repeat(64);
    const parsed = userData(renderUserData({ ...spec, installerSha256: hash }));
    const script = parsed.write_files[2]?.content.replaceAll("/root/", `${temp}/`);
    if (!script) throw Error("Missing installer download script");
    const result = spawnSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH ?? ""}`,
        MARKER: marker,
        DOWNLOAD: body,
      },
    });
    if (valid) {
      expect(result.status, result.stderr?.toString()).toBe(0);
      expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([
        "--boot-spec",
        join(temp, "opensteer-home-boot.json"),
        "--bootstrap-token-file",
        token,
      ]);
    } else {
      expect(result.status).toBe(1);
      expect(() => readFileSync(marker)).toThrow(/ENOENT/u);
    }
    expect(readFileSync(token, "utf8")).toBe(spec.bootstrapToken);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
