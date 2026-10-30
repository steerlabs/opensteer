import { voicePlaces } from "./places.js";
import { VoiceController, type VoiceTarget } from "@opensteer/client/voice";
import { StackActions } from "@react-navigation/native";
import { randomUUID } from "expo-crypto";
import { useEffect, useState, type ReactNode } from "react";
import { workspaceRoute } from "../browser/surface-route.js";
import { useDictation } from "../dictation/context.js";
import { navigationRef } from "../navigation-ref.js";
import { useVoiceBackgroundStop } from "../platform/use-voice-background-stop.js";
import { voiceMediaPort } from "../platform/voice.js";
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
      places: () => voicePlaces(hostClient, navigationRef.getCurrentRoute()),
      onStart: async () => {
        const owner = dictation.getSnapshot().owner;
        if (owner) await dictation.stop(owner);
      },
    });
    setController(created);
    return () => {
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

function show(deploymentId: string | null, target: VoiceTarget): void {
  if (!deploymentId || !navigationRef.isReady()) return;
  if (target.kind === "back") {
    if (navigationRef.canGoBack()) navigationRef.goBack();
  } else if (target.kind === "chat") navigationRef.navigate("Home", { deploymentId });
  else if (target.kind === "thread")
    navigationRef.dispatch(
      StackActions.push("Thread", { deploymentId, threadId: target.threadId }),
    );
  else
    navigationRef.dispatch(
      StackActions.push("WorkspaceBrowser", workspaceRoute(deploymentId, null, target.destination)),
    );
}
