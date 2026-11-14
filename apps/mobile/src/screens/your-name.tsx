import type { AccountProfile } from "@opensteer/control-plane-protocol";
import { normalizePersonName } from "@opensteer/core";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { useMobileTeams } from "../team/team-context.js";
import { useSelectedHostClient } from "../ui/mobile-client-context.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

export type YourNameParams = {
  /**
   * `owner`: the open Opensteer's owner, from its Settings → Account; it keeps the name with its
   * linked Account. `account`: the signed-in Account's name, from a team, which every team
   * session on this phone relays.
   */
  readonly target: "owner" | "account";
};

const conflict = "Your name was changed on another device just now. Check it, then save again.";

/** The person's one name, edited where they opened it from. */
export function YourNameScreen(props: StaticScreenProps<YourNameParams>): ReactNode {
  const { target } = props.route.params;
  const navigation = useNavigation();
  const host = useSelectedHostClient();
  const { profiles } = useMobileTeams();
  const subscribe = useCallback(
    (listener: () => void) => host?.subscribe(listener) ?? (() => undefined),
    [host],
  );
  const readOwner = useCallback(() => host?.getSnapshot().ownerProfile ?? null, [host]);
  const owner = useSyncExternalStore(subscribe, readOwner, readOwner);
  const [account, setAccount] = useState<AccountProfile | null>(null);
  // What the person is editing: the stored name and its revision when the screen opened.
  const [base, setBase] = useState<{ name: string | null; revision: number | null } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target !== "account" || profiles === null) return;
    let current = true;
    void profiles.current().then((profile) => {
      if (!current) return;
      setAccount(profile);
      setBase(
        (held) => held ?? (profile ? { name: profile.name, revision: profile.revision } : null),
      );
    });
    return () => {
      current = false;
    };
  }, [profiles, target]);
  useEffect(() => {
    if (target === "owner" && owner !== null)
      setBase((held) => held ?? { name: owner.name, revision: owner.revision });
  }, [owner, target]);

  const stored = target === "owner" ? (owner?.name ?? null) : (account?.name ?? null);
  const unavailable = base === null || (target === "owner" ? owner === null : account === null);
  const value = draft ?? base?.name ?? "";
  const blank = value.trim() === "";
  const name = normalizePersonName(value);
  // Only an owner's own name may be cleared back to "You"; an Account always has one.
  const clearable = target === "owner" && owner !== null && !owner.accountBacked;
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
    setSaving(true);
    setError(null);
    const saved: Promise<{ applied: boolean; revision: number | null }> =
      target === "owner" && host !== null
        ? host.setOwnerName(name, base.revision).then(({ applied }) => {
            profiles?.changed();
            return { applied, revision: host.getSnapshot().ownerProfile?.revision ?? null };
          })
        : profiles !== null && name !== null && base.revision !== null
          ? profiles
              .update({ name, expectedRevision: base.revision })
              .then(({ applied, profile }) => {
                setAccount(profile);
                return { applied, revision: profile.revision };
              })
          : Promise.reject(new Error("Sign in to your Opensteer Account to set your name."));
    void saved
      .then(({ applied, revision }) => {
        if (applied) {
          navigation.goBack();
          return;
        }
        setBase({ name: stored, revision });
        setDraft(null);
        setError(conflict);
      })
      .catch((reason: unknown) => setError(operationDetail(reason, "Your name wasn’t saved.")))
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
              ? target === "account"
                ? "Sign in to your Opensteer Account to set your name."
                : "Open your Opensteer to set your name."
              : clearable
                ? "Your agent calls you by this name. It stays on your computer until you sign in."
                : "Teammates see this name, and your agent calls you by it. Handles stay the same.",
          },
    },
  ];
  return <NativeSettingsPage sections={sections} />;
}
