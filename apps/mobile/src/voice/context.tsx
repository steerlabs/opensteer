import { authorizeAiSharing, useAiSharing } from "../ui/ai-sharing.js";
import { conversationRoute, show } from "./navigation.js";
import { VoiceController } from "@opensteer/client/voice";
import { handlePersonShow } from "@opensteer/client/host";
import { VoiceContext } from "@opensteer/client/react";
import { AppState } from "react-native";
import { randomUUID } from "expo-crypto";
import { useEffect, useState, type ReactNode } from "react";
import { useDictation } from "../dictation/context.js";
import { navigationRef } from "../navigation-ref.js";
import { useVoiceBackgroundStop } from "../platform/use-voice-background-stop.js";
import { voiceMediaPort } from "../platform/voice.js";
import { useMobileClient, useSelectedHostClient } from "../ui/mobile-client-context.js";

type RouteParams = { deploymentId?: string; threadId?: string; tabId?: string } | undefined;

/**
 * The runtime's one voice controller for the attached Host: a new Host ends
 * the call. Starting voice ends dictation, keeping its words, so only one
 * thing holds the microphone; leaving the foreground ends the call. A Run's
 * `host.show` changes the screen here when it comes from the conversation on
 * screen or beneath a place on it, or from the voice call this phone holds.
 */
export function VoiceProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const client = useMobileClient();
  const aiSharing = useAiSharing();
  const hostClient = useSelectedHostClient();
  const dictation = useDictation();
  const [controller, setController] = useState<VoiceController | null>(null);
  useEffect(() => {
    if (!hostClient) return;
    const created = new VoiceController({
      hostClient,
      authorize: () => authorizeAiSharing(aiSharing, hostClient, "audio"),
      media: voiceMediaPort,
      createId: randomUUID,
      currentView: () => {
        const route = navigationRef.getCurrentRoute();
        const params = route?.params as RouteParams;
        return {
          threadId: route?.name === "Thread" ? (params?.threadId ?? null) : null,
          tabId: route?.name === "WorkspaceBrowser" ? (params?.tabId ?? null) : null,
        };
      },
      onStart: async () => {
        const owner = dictation.getSnapshot().owner;
        if (owner) await dictation.stop(owner);
      },
    });
    const unsubscribeShow = hostClient.subscribePersonShow((message) => {
      const route = conversationRoute();
      const params = route?.params as RouteParams;
      const snapshot = hostClient.getSnapshot();
      // A screen without this Deployment's id, such as Settings, shows none of its conversations.
      const here = params?.deploymentId === snapshot.deploymentId;
      const shown = handlePersonShow(
        snapshot,
        message,
        {
          foreground: AppState.currentState === "active",
          call: created.call(),
          threadId: here && route?.name === "Thread" ? (params?.threadId ?? null) : null,
        },
        (target) => show(client.getSnapshot().selection.deploymentId, target),
      );
      if (shown) created.showed(message);
    });
    const unsubscribeNavigation = navigationRef.addListener("state", () =>
      created.refreshContext(),
    );
    setController(created);
    return () => {
      unsubscribeShow();
      unsubscribeNavigation();
      created.dispose();
      setController(null);
    };
  }, [aiSharing, client, dictation, hostClient]);
  return (
    <VoiceContext value={controller}>
      {controller ? <BackgroundStop controller={controller} /> : null}
      {children}
    </VoiceContext>
  );
}

function BackgroundStop({ controller }: { readonly controller: VoiceController }): null {
  useVoiceBackgroundStop(controller);
  return null;
}
