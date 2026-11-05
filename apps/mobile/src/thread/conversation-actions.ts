import { buildMobileThreadDeepLink, DeploymentIdSchema, ThreadIdSchema } from "@opensteer/core";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { Alert } from "react-native";
import type { NativeMenuOption } from "./composer-menu.js";

/**
 * What a person can do with any conversation, wherever its menu is drawn: the
 * title's menu, or the composer's beside a page, where there is no title menu.
 */
export function conversationActions(props: {
  readonly deploymentId: string;
  readonly onFind: () => void;
  readonly threadId: string;
}): readonly NativeMenuOption[] {
  const link = threadLink(props.deploymentId, props.threadId);
  return [
    {
      icon: "magnifyingglass",
      id: "find",
      label: "Find in conversation…",
      onPress: props.onFind,
    },
    ...(link === null
      ? []
      : [
          {
            icon: "link" as const,
            id: "link",
            label: "Copy thread link",
            onPress: () => copyThreadLink(link),
          },
        ]),
  ];
}

/** Offered only when both ids parse: a link that names nothing openable is worse than none. */
function threadLink(deploymentId: string, threadId: string): string | null {
  const deployment = DeploymentIdSchema.safeParse(deploymentId);
  const thread = ThreadIdSchema.safeParse(threadId);
  if (!deployment.success || !thread.success) return null;
  return buildMobileThreadDeepLink({
    deploymentId: deployment.data,
    requestId: null,
    threadId: thread.data,
  });
}

function copyThreadLink(link: string): void {
  void Clipboard.setStringAsync(link).then(
    () => Haptics.selectionAsync(),
    () => Alert.alert("Link not copied", "This thread's link could not be put on the clipboard."),
  );
}
