import { normalizePersonName } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";
import { useSelectedHostClient } from "../ui/mobile-client-context.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsSection } from "./native-settings-page.types.js";
import { failureWords } from "../ui/client-feedback.js";

export type YourNameParams = {
  /** `owner`: the open Opensteer's owner, from its Settings → Account; it keeps the name with its linked Account. */
  readonly target: "owner";
};

const conflict = "Your name was changed on another device just now. Check it, then save again.";

/** The person's one name, edited where they opened it from. */
export function YourNameScreen(_props: StaticScreenProps<YourNameParams>): ReactNode {
  const navigation = useNavigation();
  const host = useSelectedHostClient();
  const subscribe = useCallback(
    (listener: () => void) => host?.subscribe(listener) ?? (() => undefined),
    [host],
  );
  const readOwner = useCallback(() => host?.getSnapshot().ownerProfile ?? null, [host]);
  const owner = useSyncExternalStore(subscribe, readOwner, readOwner);
  // What the person is editing: the stored name and its version when the screen opened.
  const [base, setBase] = useState<{ name: string | null; version: string | null } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (owner !== null) setBase((held) => held ?? { name: owner.name, version: owner.version });
  }, [owner]);

  const stored = owner?.name ?? null;
  const unavailable = base === null || owner === null;
  const value = draft ?? base?.name ?? "";
  const blank = value.trim() === "";
  const name = normalizePersonName(value);
  // Only an owner's own name may be cleared back to "You"; an Account always has one.
  const clearable = owner !== null && !owner.accountBacked;
  const valid = name !== null || (blank && clearable);
  const changed = valid && name !== stored;

  const save = (): void => {
    if (unavailable || saving) return;
    if (!valid) {
      setError(blank ? "Enter your name." : "Use a name of up to 120 characters.");
      return;
    }
    if (!changed) {
      navigation.goBack();
      return;
    }
    if (host === null) {
      setError("Open your Opensteer to set your name.");
      return;
    }
    setSaving(true);
    setError(null);
    // Each answer carries the name now stored, so a refused save shows the newer one.
    void host
      .setOwnerName(name, base.version)
      .then(({ applied }) => {
        if (applied) {
          navigation.goBack();
          return;
        }
        const now = host.getSnapshot().ownerProfile;
        setBase({ name: now?.name ?? null, version: now?.version ?? null });
        setDraft(null);
        setError(conflict);
      })
      .catch((reason: unknown) =>
        setError(
          failureWords(
            reason,
            { label: "save your name", done: "saved", happened: "your name was saved" },
            "Your name wasn’t saved.",
          ),
        ),
      )
      .finally(() => setSaving(false));
  };

  const sections: NativeSettingsSection[] = [
    {
      key: "name",
      title: "",
      rows: [
        { key: "name", kind: "input", label: "Name", value, onChange: setDraft, onSubmit: save },
        ...(Platform.OS === "android" && changed
          ? [
              {
                key: "save",
                kind: "button" as const,
                label: saving ? "Saving…" : "Save name",
                disabled: saving,
                onPress: save,
              },
            ]
          : []),
      ],
      footer: error
        ? { text: error, tone: "danger" }
        : {
            text: unavailable
              ? "Open your Opensteer to set your name."
              : clearable
                ? "Your agent calls you by this name. It stays on your computer until you sign in."
                : "Your agent calls you by this name.",
          },
    },
  ];
  return <NativeSettingsPage sections={sections} />;
}
