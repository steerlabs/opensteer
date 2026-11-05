import { canRespondToRequests, deriveSurface, type HostSnapshot } from "@opensteer/client/host";
import type { HostClient } from "@opensteer/client/host";
import { useHostSelector } from "@opensteer/client/react";
import type { VoiceSnapshot } from "@opensteer/client/voice";
import { useMemo, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, controlFontScaleLimit, material, radius, space } from "../theme.js";
import { PasswordsSuggestion } from "../thread/passwords-suggestion.js";
import { QuestionCard } from "../thread/waiting-questions.js";
import {
  useHostUserId,
  useMobileClient,
  useSelectedHostClient,
} from "../ui/mobile-client-context.js";
import { appear, exit } from "../ui/motion.js";
import { AppText } from "../ui/primitives.js";
import { useVoiceAskedRequest, useVoiceValue } from "./use-voice-value.js";

interface AskedState {
  readonly canRespond: boolean;
  readonly machines: HostSnapshot["machines"];
  readonly user: HostSnapshot["user"];
  readonly waiting: HostSnapshot["waitingRequests"][number] | null;
}

const selectPasswords = ({ ask }: VoiceSnapshot) => ask?.kind === "passwords";
const selectPasswordsCard = ({ ask }: VoiceSnapshot) => ask?.kind === "passwords" && ask.card;
const selectOthers = ({ ask }: VoiceSnapshot) => (ask?.kind === "request" ? ask.others : 0);

/**
 * What the call needs from the person, stacked on the call bar wherever they
 * are, so answering never takes them off the screen they chose.
 */
export function VoiceAsk(): ReactNode {
  const requestId = useVoiceAskedRequest();
  const passwords = useVoiceValue(selectPasswords);
  const hostClient = useSelectedHostClient();
  if (hostClient === null) return null;
  if (requestId !== null) return <AskedRequest hostClient={hostClient} requestId={requestId} />;
  return passwords ? <AskedPasswords hostClient={hostClient} /> : null;
}

function AskedRequest(props: {
  readonly hostClient: HostClient;
  readonly requestId: string;
}): ReactNode {
  const { hostClient, requestId } = props;
  const client = useMobileClient();
  const others = useVoiceValue(selectOthers);
  const select = useMemo(
    () =>
      (snapshot: HostSnapshot): AskedState => ({
        canRespond: canRespondToRequests(snapshot),
        machines: snapshot.machines,
        user: snapshot.user,
        waiting: snapshot.waitingRequests.find(({ request }) => request.id === requestId) ?? null,
      }),
    [requestId],
  );
  const { canRespond, machines, user, waiting } = useHostSelector(hostClient, select, sameAsk);
  const surface = useMemo(
    () => (waiting === null ? null : deriveSurface([waiting.request], user)),
    [user, waiting],
  );
  const deploymentId = client.getSnapshot().selection.deploymentId;
  if (surface === null || user === null || deploymentId === null) return null;
  return (
    <Animated.View entering={appear} exiting={exit} style={styles.asked}>
      <QuestionCard
        canRespond={canRespond}
        deploymentId={deploymentId}
        drafts={client.drafts}
        hostClient={hostClient}
        key={surface.request.id}
        machines={machines}
        subagentTitle={waiting?.subagent?.title ?? null}
        surface={surface}
        userId={user.id}
      />
      {others > 0 ? (
        <View style={styles.more}>
          <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="caption" tone="soft">
            {others} more waiting
          </AppText>
        </View>
      ) : null}
    </Animated.View>
  );
}

function sameAsk(left: AskedState, right: AskedState): boolean {
  return (
    left.canRespond === right.canRespond &&
    left.machines === right.machines &&
    left.user === right.user &&
    left.waiting === right.waiting
  );
}

function AskedPasswords(props: { readonly hostClient: HostClient }): ReactNode {
  const card = useVoiceValue(selectPasswordsCard);
  const deploymentId = useMobileClient().getSnapshot().selection.deploymentId;
  const userId = useHostUserId(props.hostClient);
  if (deploymentId === null || userId === null) return null;
  return (
    <Animated.View entering={appear} exiting={exit}>
      <PasswordsSuggestion
        card={card}
        deploymentId={deploymentId}
        hostClient={props.hostClient}
        userId={userId}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  asked: { gap: space[4] },
  more: {
    ...material.plate,
    alignSelf: "center",
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.full,
    paddingHorizontal: space[10],
    paddingVertical: space[2],
  },
});
