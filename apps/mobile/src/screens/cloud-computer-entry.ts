import { cloudWords } from "@opensteer/client/computers";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

/**
 * The Cloud Computer on a Home's own page: offered only on a Mac Home. A networked Home is
 * a server or the Cloud Computer itself, so it is never offered there.
 */
export function homeCloudComputerSection(input: {
  readonly home: boolean;
  readonly exposure: "loopback" | "networked" | undefined;
  readonly onOpen: () => void;
}): NativeSettingsSection | null {
  if (!input.home || input.exposure === "networked") return null;
  return {
    key: "cloud-computer",
    title: "",
    rows: [
      {
        key: "cloud-computer",
        kind: "button",
        label: cloudWords("cloud.entry.title"),
        detail: cloudWords("cloud.entry.detail"),
        symbol: "cloud",
        opens: true,
        onPress: input.onOpen,
      },
    ],
  };
}
