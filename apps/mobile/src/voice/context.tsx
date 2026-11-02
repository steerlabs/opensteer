import { show } from "./navigation.js";
import { voicePlaces } from "./places.js";
import { VoiceController } from "@opensteer/client/voice";
import { randomUUID } from "expo-crypto";
import { useEffect, useState, type ReactNode } from "react";
import { paramsDestination } from "../browser/surface-route.js";
import { useDictation } from "../dictation/context.js";
import { navigationRef } from "../navigation-ref.js";
import { useVoiceBackgroundStop } from "../platform/use-voice-background-stop.js";
import { voiceMediaPort } from "../platform/voice.js";
import { macWindowVideoSupported } from "../computers/phone-display-native.js";
import { useMobileClient, useSelectedHostClient } from "../ui/mobile-client-context.js";
import { VoiceContext } from "./controls.js";

/**
 * The runtime's one voice controller for the attached Host: a new Host ends
 * the call. Starting voice ends dictation, keeping its words, so only one
 * thing holds the microphone; leaving the foreground ends the call.
 */
export function VoiceProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const client = useMobileClient();
  const hostClient = useSelectedHostClient();
  const dictation = useDictation();
  const [controller, setController] = useState<VoiceController | null>(null);
  useEffect(() => {
    if (!hostClient) return;
    const created = new VoiceController({
      hostClient,
      media: voiceMediaPort,
      navigate: (target) => show(client.getSnapshot().selection.deploymentId, target),
      createId: randomUUID,
      currentView: () => {
        const route = navigationRef.getCurrentRoute();
        const params = route?.params as { threadId?: string } | undefined;
        return {
          threadId:
            route?.name === "Home"
              ? (hostClient.getSnapshot().homeThreadId ?? undefined)
              : params?.threadId,
          destination: paramsDestination(params) ?? undefined,
          title: route?.name,
        };
      },
      places: () => voicePlaces(hostClient, navigationRef.getCurrentRoute()),
      // A binary without qualified Mac video shows a placeholder, so the call isn't offered Mac apps.
      canShow: (destination) => destination.kind !== "app" || macWindowVideoSupported(),
      onStart: async () => {
        const owner = dictation.getSnapshot().owner;
        if (owner) await dictation.stop(owner);
      },
    });
    const unsubscribe = navigationRef.addListener("state", () => created.refreshContext());
    setController(created);
    return () => {
      unsubscribe();
      created.dispose();
      setController(null);
    };
  }, [client, dictation, hostClient]);
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
