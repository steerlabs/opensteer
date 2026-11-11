import { MenuView } from "@expo/ui/community/menu";
import { useActionReview } from "@opensteer/client/react";
import type { AgentCard, HostClient } from "@opensteer/client/host";
import { Alert, Pressable } from "react-native";
import type { ReactNode } from "react";
import { ActionReviewSheet } from "../ui/action-review.js";
import { Symbol } from "../ui/symbol.js";
import { color, touchTarget } from "../theme.js";
import { operationDetail } from "../client/mobile-client.js";

export function SubagentStop(props: {
  readonly card: AgentCard;
  readonly hostClient: HostClient;
  readonly children?: ReactNode | ((onStop: () => void) => ReactNode);
}) {
  const { card, hostClient, children } = props;
  const { review, ask, dismiss } = useActionReview(hostClient);
  const request = () => {
    if (card.stop) ask({ kind: "stop-node", ...card.stop });
  };
  const content = typeof children === "function" ? children(request) : children;
  if (!card.stop) return content ?? null;
  return (
    <>
      {content ? (
        <MenuView
          colorScheme="dark"
          actions={[
            {
              id: "stop",
              image: "stop",
              title: `Stop ${card.kind === "workflow" ? "workflow" : "subagent"}`,
              attributes: { destructive: true },
            },
          ]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "stop") request();
          }}
          shouldOpenOnLongPress
        >
          {content}
        </MenuView>
      ) : (
        <Pressable
          accessibilityLabel={`Stop ${card.title}`}
          accessibilityRole="button"
          onPress={request}
          style={{
            minHeight: touchTarget,
            minWidth: touchTarget,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Symbol name="stop.fill" size={16} tint={color.muted} />
        </Pressable>
      )}
      <ActionReviewSheet
        review={review}
        title={`Stop ${card.title}?`}
        detail="Nothing it already did is undone."
        confirmLabel={`Stop ${card.kind === "workflow" ? "workflow" : "subagent"}`}
        cancelLabel="Keep working"
        onClose={dismiss}
        onError={(error) =>
          Alert.alert(`${card.title} was not stopped`, operationDetail(error, "Try again."))
        }
      />
    </>
  );
}
