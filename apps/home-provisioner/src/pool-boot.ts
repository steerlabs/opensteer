import { isBareOrigin, refused } from "@opensteer/core";
import {
  BrowserPoolHostIdSchema,
  BrowserPoolSpkiBase64Schema,
  CloudComputerBootstrapTokenSchema,
  CloudComputerGenerationSchema,
  CloudComputerInstallerSha256Schema,
  CloudComputerInstallerUrlSchema,
  defaultBrowserPoolAdminPort,
  defaultBrowserPoolAgentPort,
  defaultBrowserPoolRelayPort,
} from "@opensteer/control-plane-protocol";
import { z } from "zod";
import { googleBootstrapReadyKey } from "./boot.js";

export const poolProfileDiskDeviceName = "opensteer-profiles";
export const poolProfileDiskDevicePath = `/dev/disk/by-id/google-${poolProfileDiskDeviceName}`;

const ipv4Cidr = z.string().regex(/^(?:\d{1,3}\.){3}\d{1,3}\/(?:[0-9]|[12][0-9]|3[0-2])$/u);

const PoolHostBootSpecSchema = z.object({
  hostId: BrowserPoolHostIdSchema,
  generation: CloudComputerGenerationSchema,
  accountOrigin: z.url({ protocol: /^https$/u }).refine(isBareOrigin),
  installerUrl: CloudComputerInstallerUrlSchema,
  installerSha256: CloudComputerInstallerSha256Schema,
  bootstrapToken: CloudComputerBootstrapTokenSchema,
  provisionerKey: BrowserPoolSpkiBase64Schema,
  homeCidr: ipv4Cidr,
  provisionerCidr: ipv4Cidr,
  profileDiskDevice: z.string().regex(/^\/dev\/[A-Za-z0-9._/-]{1,128}$/u),
  everEnrolled: z.boolean().default(true),
  agentPort: z.number().int().min(1).max(65_535).default(defaultBrowserPoolAgentPort),
  adminPort: z.number().int().min(1).max(65_535).default(defaultBrowserPoolAdminPort),
  relayPort: z.number().int().min(1).max(65_535).default(defaultBrowserPoolRelayPort),
});
export type PoolHostBootSpec = z.infer<typeof PoolHostBootSpecSchema>;

const specPath = "/root/opensteer-pool-boot.json";
const tokenPath = "/root/opensteer-pool-bootstrap-token";
const downloadPath = "/root/opensteer-pool-download.sh";
const downloadUnit = "opensteer-pool-download.service";
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export function renderPoolHostUserData(
  input: PoolHostBootSpec,
  gateOnGoogleMetadata = false,
): string {
  const parsed = PoolHostBootSpecSchema.safeParse(input);
  if (!parsed.success) throw refused("bad_request", "Invalid browser pool host boot specification");
  const { bootstrapToken, ...spec } = parsed.data;
  const script = [
    "set -eu",
    "umask 077",
    ...(gateOnGoogleMetadata
      ? [
          // Compute starts the VM during insert. Wait for Account to record its ref and open
          // the bootstrap window before the installer makes a request that could spend the token.
          `curl -q --fail --silent --noproxy '*' --max-time 5 -H 'Metadata-Flavor: Google' http://metadata.google.internal/computeMetadata/v1/instance/attributes/${googleBootstrapReadyKey} | grep -qx 1`,
        ]
      : []),
    "installer=$(mktemp /root/opensteer-pool-installer.XXXXXX)",
    `trap 'rm -f "$installer"' EXIT`,
    `curl -q --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 --output "$installer" -- ${quote(spec.installerUrl)}`,
    `printf '%s  %s\\n' '${spec.installerSha256}' "$installer" | sha256sum -c - >/dev/null`,
    `bash "$installer" --boot-spec ${specPath} --bootstrap-token-file ${tokenPath}`,
  ].join("\n");

  const unit = `[Unit]
Description=Download and enrol the Opensteer browser pool host
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
