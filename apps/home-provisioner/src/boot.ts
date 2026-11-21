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
const tokenPath = "/root/opensteer-home-bootstrap-token";
const downloadPath = "/root/opensteer-home-download.sh";
const downloadUnit = "opensteer-home-download.service";
export const googleBootstrapReadyKey = "opensteer-bootstrap-ready";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function renderUserData(input: HomeBootSpec, gateOnGoogleMetadata = false): string {
  const parsed = HomeBootSpecSchema.safeParse(input);
  if (!parsed.success) throw refused("bad_request", "Invalid Cloud Computer boot specification");
  const { bootstrapToken, ...spec } = parsed.data;
  const script = [
    "set -eu",
    "umask 077",
    ...(gateOnGoogleMetadata
      ? [
          // Compute starts the VM during insert. Wait for the Account to record its ID and open
          // the bootstrap window before the installer makes a request that could spend the token.
          `curl -q --fail --silent --noproxy '*' --max-time 5 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/${googleBootstrapReadyKey} | grep -qx 1`,
        ]
      : []),
    "installer=$(mktemp /root/opensteer-home-installer.XXXXXX)",
    `trap 'rm -f "$installer"' EXIT`,
    `curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 --output "$installer" -- ${quote(spec.installerUrl)}`,
    `printf '%s  %s\\n' '${spec.installerSha256}' "$installer" | sha256sum -c - >/dev/null`,
    `bash "$installer" --boot-spec ${specPath} --bootstrap-token-file ${tokenPath}`,
  ].join("\n");

  const unit = `[Unit]
Description=Download the Opensteer Home installer
Wants=network-online.target
After=network-online.target
ConditionPathExists=${tokenPath}
StartLimitIntervalSec=0

[Service]
Type=oneshot
ExecStart=/bin/bash ${downloadPath}
Restart=on-failure
RestartSec=10s
RestartSteps=5
RestartMaxDelaySec=60s

[Install]
WantedBy=multi-user.target
`;

  return (
    "#cloud-config\n" +
    JSON.stringify({
      write_files: [
        { path: specPath, owner: "root:root", permissions: "0600", content: JSON.stringify(spec) },
        { path: tokenPath, owner: "root:root", permissions: "0600", content: bootstrapToken },
        { path: downloadPath, owner: "root:root", permissions: "0600", content: script },
        {
          path: `/etc/systemd/system/${downloadUnit}`,
          owner: "root:root",
          permissions: "0600",
          content: unit,
        },
      ],
      runcmd: [
        ["systemctl", "daemon-reload"],
        ["systemctl", "enable", "--now", "--no-block", downloadUnit],
      ],
    }) +
    "\n"
  );
}
