import { isBareOrigin, refused } from "@opensteer/core";
import {
  CloudComputerBootstrapTokenSchema,
  CloudComputerHostnameSchema,
  CloudComputerIdSchema,
  CloudComputerInstallerSha256Schema,
  CloudComputerInstallerUrlSchema,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";

const HomeBootSpecSchema = z.object({
  cloudComputerId: CloudComputerIdSchema,
  accountOrigin: z.url({ protocol: /^https$/u }).refine(isBareOrigin),
  hostname: CloudComputerHostnameSchema,
  installerUrl: CloudComputerInstallerUrlSchema,
  installerSha256: CloudComputerInstallerSha256Schema,
  bootstrapToken: CloudComputerBootstrapTokenSchema,
});
export type HomeBootSpec = z.infer<typeof HomeBootSpecSchema>;

const specPath = "/root/opensteer-home-boot.json";
const tokenPath = "/run/opensteer-home-bootstrap-token";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function renderUserData(input: HomeBootSpec): string {
  const parsed = HomeBootSpecSchema.safeParse(input);
  if (!parsed.success) throw refused("bad_request", "Invalid Cloud Computer boot specification");
  const { bootstrapToken, ...spec } = parsed.data;
  const script = [
    "set -eu",
    "umask 077",
    "installer=$(mktemp /root/opensteer-home-installer.XXXXXX)",
    `trap 'rm -f "$installer" ${tokenPath}' EXIT`,
    `curl -q --fail --silent --show-error --proto '=https' --max-time 120 --output "$installer" -- ${quote(spec.installerUrl)}`,
    `printf '%s  %s\\n' '${spec.installerSha256}' "$installer" | sha256sum -c - >/dev/null`,
    `bash "$installer" --boot-spec ${specPath} --bootstrap-token-file ${tokenPath}`,
  ].join("\n");

  return (
    "#cloud-config\n" +
    JSON.stringify({
      write_files: [
        { path: specPath, owner: "root:root", permissions: "0600", content: JSON.stringify(spec) },
        { path: tokenPath, owner: "root:root", permissions: "0600", content: bootstrapToken },
      ],
      runcmd: [["bash", "-c", script]],
    }) +
    "\n"
  );
}
