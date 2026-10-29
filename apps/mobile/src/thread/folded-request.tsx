import { deriveSurface, type HostSnapshot, type SurfaceModel } from "@opensteer/client/host";
import type { AuthenticatedUser, Request } from "@opensteer/core";
import { useMemo, type ReactNode } from "react";
import { Pressable, StyleSheet } from "react-native";
import Animated from "react-native-reanimated";
import { color, radius, space, touchTarget } from "../theme.js";
import { appear } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { requestTitleLine, waitingQuestion } from "./docked-requests.js";

/**
 * What needs the reader, folded under a page to one line: a task's question
 * first, as the open sheet docks it first, then this conversation's own.
 */
export function FoldedRequest(props: {
  readonly onReview: () => void;
  readonly ownRequests: readonly Request[];
  readonly threadId: string;
  readonly user: AuthenticatedUser;
  readonly waitingRequests: HostSnapshot["waitingRequests"];
}): ReactNode {
  const { ownRequests, threadId, user, waitingRequests } = props;
  const surface = useMemo(
    () =>
      waitingQuestion(waitingRequests, threadId, user)?.surface ?? deriveSurface(ownRequests, user),
    [ownRequests, threadId, user, waitingRequests],
  );
  return surface === null ? null : (
    <FoldedRequestLine key={surface.request.id} onReview={props.onReview} surface={surface} />
  );
}

/**
 * Folded under a page, what waits on the reader is one amber line: the first
 * request and Review, which opens the conversation where its card is. The card
 * is drawn only there, so a request is never shown twice.
 */
function FoldedRequestLine(props: {
  readonly onReview: () => void;
  readonly surface: SurfaceModel;
}): ReactNode {
  // Someone else answers a request the reader may not, so it is not theirs to review.
  const theirs = props.surface.denied === null;
  const word = theirs ? "Needs you" : "Waiting on someone";
  const title = requestTitleLine(props.surface.request);
  return (
    <Animated.View entering={appear}>
      <Pressable
        accessibilityHint="Shows the conversation, with the request to review"
        accessibilityLabel={`${word}: ${title}`}
        accessibilityRole="button"
        onPress={props.onReview}
        style={({ pressed }) => [styles.line, pressed && styles.pressed]}
      >
        <AppText
          numberOfLines={1}
          role="secondary"
          style={[styles.words, theirs && styles.amber]}
          tone="muted"
        >
          {`${word} · ${title}`}
        </AppText>
        <AppText role="secondaryMedium" tone={theirs ? "ember" : "muted"}>
          {theirs ? "Review" : "View"}
        </AppText>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  amber: { color: color.amber },
  line: {
    alignItems: "center",
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[14],
  },
  pressed: { opacity: 0.7 },
  words: { flex: 1 },
});
