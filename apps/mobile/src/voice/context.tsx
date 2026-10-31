import { VoiceController } from "@opensteer/client/voice";
import { randomUUID } from "expo-crypto";
import { useEffect, useState, type ReactNode } from "react";
import { AppState, Keyboard, Platform, TextInput } from "react-native";
import { useDictation } from "../dictation/context.js";
import { navigationRef } from "../navigation-ref.js";
import { useVoiceBackgroundStop } from "../platform/use-voice-background-stop.js";
import { voiceMediaPort } from "../platform/voice.js";
import { useMobileClient, useSelectedHostClient } from "../ui/mobile-client-context.js";
import { VoiceContext } from "./controls.js";
import { mobileScreenPresentation, type PresentationDevice } from "./presentation.js";

const device: PresentationDevice = {
  active: () => AppState.currentState === "active",
  editing: () => TextInput.State.currentlyFocusedInput() != null,
  macVideo: Platform.OS !== "ios",
  observe(listener) {
    const keyboard = Keyboard.addListener("keyboardDidShow", listener);
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") listener();
    });
    return () => {
      keyboard.remove();
      app.remove();
    };
  },
};

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
    const presentation = mobileScreenPresentation({
      navigator: navigationRef,
      device,
      hostClient,
      deploymentId: () => client.getSnapshot().selection.deploymentId,
    });
    const created = new VoiceController({
      hostClient,
      media: voiceMediaPort,
      navigate: presentation.show,
      presentation: presentation.port,
      createId: randomUUID,
      onStart: async () => {
        const owner = dictation.getSnapshot().owner;
        if (owner) await dictation.stop(owner);
      },
    });
    setController(created);
    return () => {
      created.dispose();
      presentation.dispose();
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
