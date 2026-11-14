import type { AccountProfile } from "@opensteer/control-plane-protocol";
import { normalizePersonName } from "@opensteer/core";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Platform } from "react-native";
import { operationDetail } from "../client/mobile-client.js";
import { useMobileTeams } from "../team/team-context.js";
import { useSelectedHostClient } from "../ui/mobile-client-context.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

/**
 * The person's one name, from Settings → Account or a team's profile row. With their Opensteer
 * open it is saved there, which keeps it with their Account when linked; with only teams on this
 * phone it is saved to their Account directly. Either way every team session relays it.
 */
export function YourNameScreen(): ReactNode {
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
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (owner !== null || profiles === null) return;
    let current = true;
    void profiles.current().then((profile) => current && setAccount(profile));
    return () => {
      current = false;
    };
  }, [owner, profiles]);

  const stored = owner !== null ? owner.name : (account?.name ?? null);
  // A name kept only on this computer may be cleared back to "You"; an Account's may not.
  const clearable = owner !== null && !owner.accountBacked;
  const value = draft ?? stored ?? "";
  const name = normalizePersonName(value);
  const changed = name !== stored && (name !== null || clearable);
  const unavailable = owner === null && account === null;

  const save = (): void => {
    if (!changed || saving || unavailable) return;
    setSaving(true);
    setError(null);
    const saved =
      owner !== null && host !== null
        ? host.setOwnerName(name).then(({ applied }) => {
            profiles?.changed();
            return applied;
          })
        : profiles !== null && account !== null && name !== null
          ? profiles
              .update({ name, expectedRevision: account.revision })
              .then(({ applied, profile }) => {
                setAccount(profile);
                return applied;
              })
          : Promise.resolve(false);
    void saved
      .then((applied) => {
        if (applied) navigation.goBack();
        else {
          setDraft(null);
          setError("Your name was changed on another device just now. Check it, then save again.");
        }
      })
      .catch((reason: unknown) => setError(operationDetail(reason, "Your name wasn’t saved.")))
      .finally(() => setSaving(false));
  };

  const sections: NativeSettingsSection[] = [
    {
      key: "name",
      title: "",
      rows: [
        {
          key: "name",
          kind: "input",
          label: "Name",
          value,
          onChange: setDraft,
          onSubmit: save,
        },
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
              ? "Sign in to your Opensteer Account to set your name."
              : owner !== null && !owner.accountBacked
                ? "Your agent calls you by this name. It stays on your computer until you sign in."
                : "Teammates see this name, and your agent calls you by it. Handles stay the same.",
          },
    },
  ];
  return <NativeSettingsPage sections={sections} />;
}
