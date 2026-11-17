export function verifyIphoneBridgeRelease(
  directory: string,
  options: {
    architecture: "arm64" | "amd64";
    release: boolean;
    teamId?: string | undefined;
  },
): {
  schemaVersion: 1;
  operatingSystem: "darwin";
  architecture: "arm64" | "amd64";
  binarySha256: string;
  protocolVersion: 1;
};
