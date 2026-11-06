import {
  AiSharing,
  aiCompanies,
  aiCompanyNames,
  genericAiCompany,
  liveAudioCompanies,
  type AiSharingPrompt,
} from "@opensteer/client/ai-sharing";
import type { HostClient } from "@opensteer/client/host";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, Linking, View } from "react-native";
import { AppText, PrimaryButton, SecondaryButton } from "./primitives.js";
import { Sheet, SheetPresenter } from "./sheet.js";
import { space } from "../theme.js";

const Context = createContext<AiSharing | null>(null);
export function useAiSharing(): AiSharing {
  const sharing = useContext(Context);
  if (!sharing) throw new Error("AI sharing requires the mobile app root.");
  return sharing;
}
export function authorizeAiSharing(
  sharing: AiSharing,
  host: HostClient,
  scope: "content" | "audio" = "content",
) {
  const initial = host.getSnapshot();
  const content = sharing.ensure("content", () => aiCompanies(host.getSnapshot()));
  // A call's audio goes to one company, but what it asks for can reach the computer's agents.
  const decided =
    scope === "audio"
      ? content.then((allowed) => allowed && sharing.ensure("audio", () => liveAudioCompanies))
      : content;
  return decided
    .then((allowed) => {
      const current = host.getSnapshot();
      return (
        allowed &&
        current.deploymentId === initial.deploymentId &&
        current.user?.id === initial.user?.id
      );
    })
    .catch(() => {
      Alert.alert("Could not save your choice", "Nothing was sent. Please try again.");
      return false;
    });
}
export function AiSharingProvider(props: {
  readonly create: (confirm: (prompt: AiSharingPrompt) => Promise<boolean>) => AiSharing;
  readonly children: ReactNode;
}) {
  const [prompt, setPrompt] = useState<AiSharingPrompt | null>(null);
  const answer = useRef<((allowed: boolean) => void) | null>(null);
  const [sharing] = useState(() =>
    props.create(
      (next) =>
        new Promise<boolean>((resolve) => {
          answer.current = resolve;
          setPrompt(next);
        }),
    ),
  );
  const finish = (allowed: boolean) => {
    const resolve = answer.current;
    answer.current = null;
    setPrompt(null);
    resolve?.(allowed);
  };
  useEffect(
    () => () => {
      answer.current?.(false);
    },
    [],
  );
  const names = aiCompanyNames(prompt?.companies ?? []);
  const single = prompt?.companies.length === 1 && prompt.companies[0] !== genericAiCompany;
  const sheet = (
    <Sheet
      anchor={false}
      open={prompt !== null}
      title={prompt?.scope === "audio" ? "Live audio sharing" : "AI sharing"}
      onClose={() => finish(false)}
    >
      <View style={{ padding: space[20], gap: space[16] }}>
        <AppText role="title">
          {prompt?.scope === "audio"
            ? `Talk with ${names}?`
            : single
              ? `Share with ${names}?`
              : "Share with your AI services?"}
        </AppText>
        <AppText>
          {prompt?.scope === "audio"
            ? `Your live microphone audio, conversation context, and information about the page you’re viewing will be sent to ${names} for voice replies. You can end the call at any time.`
            : `Your messages, attached files, conversation context, and information agents read for your tasks may be sent to ${names} to provide AI replies and carry out your requests. Your computer runs Opensteer; these services process the data you share.`}
        </AppText>
        <AppText>You can stop future sharing in Settings → AI sharing.</AppText>
        <SecondaryButton
          label="Privacy Policy"
          onPress={() => {
            void Linking.openURL("https://opensteer.com/privacy").catch(() =>
              Alert.alert("Could not open Privacy Policy"),
            );
          }}
        />
        <PrimaryButton label="Allow sharing" onPress={() => finish(true)} />
        <SecondaryButton label="Not now" onPress={() => finish(false)} />
      </View>
    </Sheet>
  );
  return (
    <Context value={sharing}>
      <SheetPresenter sheet={sheet} onDismiss={() => finish(false)}>
        {props.children}
      </SheetPresenter>
    </Context>
  );
}
