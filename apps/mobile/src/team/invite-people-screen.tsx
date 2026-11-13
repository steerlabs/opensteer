import { unwrapRpcResult } from "@opensteer/client/host";
import { createId } from "@opensteer/core";
import type { TeamCurrentInvite, TeamInviteExpiryDays } from "@opensteer/protocol";
import type { StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path, Rect } from "react-native-svg";
import { encode } from "uqr";
import { color, controlFontScaleLimit, material, radius, space, touchTarget } from "../theme.js";
import { useCopy } from "../ui/copy-mark.js";
import { AppText, Notice, PrimaryButton, SecondaryButton } from "../ui/primitives.js";
import { useTeamSession } from "./team-context.js";

const expiryChoices: readonly TeamInviteExpiryDays[] = [1, 7, 30];

/** Dark modules on a light tile with its quiet zone: cameras read dark-on-light in any theme. */
function InviteCode(props: { readonly value: string }): ReactNode {
  const { path, size } = useMemo(() => {
    const qr = encode(props.value, { border: 2, ecc: "M" });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { path: d, size: qr.size };
  }, [props.value]);
  return (
    <View
      accessibilityLabel="QR code for the invite link"
      accessibilityRole="image"
      style={styles.code}
    >
      <Svg height={148} viewBox={`0 0 ${size} ${size}`} width={148}>
        <Rect fill="#f5f4f2" height={size} width={size} />
        <Path d={path} fill="#111" />
      </Svg>
    </View>
  );
}

type InviteState =
  | { readonly kind: "loading" }
  | { readonly kind: "current"; readonly invite: TeamCurrentInvite }
  /** A team server older than reusable invites: one link per person. */
  | { readonly kind: "single-use"; readonly url: string | null }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * The team's one reusable invite: the link, Share and Copy, a code for a phone beside you,
 * how long it works, and Reset when it went somewhere it shouldn't.
 */
export function TeamInvitesScreen(
  props: StaticScreenProps<{ readonly teamId: string }>,
): ReactNode {
  const { teamId } = props.route.params;
  const { session, team, snapshot } = useTeamSession(teamId);
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<InviteState>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();
  const name = snapshot.bootstrap?.teamName ?? team?.name ?? "your team";

  /** Replaces the link on screen; with none shown, makes one only when the team has none. */
  const reset = async (expiresInDays: TeamInviteExpiryDays): Promise<void> => {
    if (session === null) return;
    const made = unwrapRpcResult(
      await session.rpc["commands.dispatch"]({
        type: "team.invite.reset",
        id: createId("teamInvite"),
        replaces: state.kind === "current" ? state.invite.id : null,
        expiresInDays,
        maxUses: null,
      }),
    );
    if (made.type === "team.invite.reset") setState({ kind: "current", invite: made.invite });
  };

  const load = async (): Promise<void> => {
    if (session === null) return;
    const result = await session.rpc["team.invite.current.get"]({});
    // A team server older than reusable invites.
    if (!result.ok && result.error.code === "not_found") {
      setState({ kind: "single-use", url: null });
      return;
    }
    const current = unwrapRpcResult(result).invite;
    if (current !== null) setState({ kind: "current", invite: current });
    else await reset(7);
  };

  useEffect(() => {
    if (session === null) return;
    let current = true;
    void load().catch(
      (error: unknown) =>
        current &&
        setState({
          kind: "failed",
          detail: error instanceof Error ? error.message : "The invite wasn't made.",
        }),
    );
    return () => {
      current = false;
    };
    // `load` is made from the session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const run = (work: () => Promise<void>): void => {
    setBusy(true);
    void work()
      .catch((error: unknown) =>
        Alert.alert("That didn't work", error instanceof Error ? error.message : undefined),
      )
      .finally(() => setBusy(false));
  };

  const url =
    state.kind === "current" ? state.invite.url : state.kind === "single-use" ? state.url : null;
  return (
    <ScrollView contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + space[24] }]}>
      <View style={styles.heading}>
        <AppText role="displaySmall">Invite people to {name}</AppText>
        <AppText role="secondary" tone="muted">
          {state.kind === "single-use"
            ? "Each link lets one person join with their Opensteer Account."
            : "Anyone with this link can join with their Opensteer Account."}
        </AppText>
      </View>
      {state.kind === "loading" ? (
        <ActivityIndicator color={color.muted} style={styles.loading} />
      ) : state.kind === "failed" ? (
        <Notice
          action={{ label: "Try again", onPress: () => run(load) }}
          detail={state.detail}
          title="No invite yet"
        />
      ) : (
        <>
          {url === null ? null : <InviteCode value={url} />}
          {url === null ? null : (
            <View style={styles.link}>
              <AppText
                numberOfLines={1}
                role="secondary"
                selectable
                style={styles.grow}
                tone="soft"
              >
                {url}
              </AppText>
              <Pressable
                accessibilityLabel={copied ? "Copied" : "Copy invite link"}
                accessibilityRole="button"
                onPress={() => void copy(url)}
                style={styles.copy}
              >
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  role="secondaryMedium"
                  tone="ember"
                >
                  {copied ? "Copied" : "Copy"}
                </AppText>
              </Pressable>
            </View>
          )}
          {url === null ? (
            <PrimaryButton
              busy={busy}
              label="Make an invite link"
              onPress={() =>
                run(async () => {
                  if (session === null) return;
                  const made = unwrapRpcResult(
                    await session.rpc["commands.dispatch"]({
                      type: "team.invite.create",
                      id: createId("teamInvite"),
                      maxUses: 1,
                      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
                    }),
                  );
                  if (made.type === "team.invite.create")
                    setState({ kind: "single-use", url: made.url });
                })
              }
              prominent
            />
          ) : (
            <PrimaryButton
              label="Share invite"
              onPress={() => void Share.share({ message: url, url })}
              prominent
            />
          )}
          {state.kind === "current" ? (
            <>
              <View style={styles.expiry}>
                <AppText role="secondaryMedium" tone="soft">
                  Link works for
                </AppText>
                <View accessibilityRole="radiogroup" style={styles.segments}>
                  {expiryChoices.map((days) => {
                    const chosen = state.invite.expiresInDays === days;
                    const label = days === 1 ? "1 day" : `${days} days`;
                    return (
                      <Pressable
                        accessibilityLabel={label}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: chosen, disabled: busy }}
                        disabled={busy}
                        key={days}
                        onPress={() => {
                          if (chosen) return;
                          Alert.alert(
                            `Make a link that works for ${label}?`,
                            "The current link stops working.",
                            [
                              { style: "cancel", text: "Cancel" },
                              { text: "Make new link", onPress: () => run(() => reset(days)) },
                            ],
                          );
                        }}
                        style={[styles.segment, chosen && styles.segmentChosen]}
                      >
                        <AppText
                          maxFontSizeMultiplier={controlFontScaleLimit}
                          role="secondaryMedium"
                          tone={chosen ? "default" : "muted"}
                        >
                          {label}
                        </AppText>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
              <SecondaryButton
                busy={busy}
                label="Reset link"
                onPress={() =>
                  Alert.alert("Reset the invite link?", "The old link stops working.", [
                    { style: "cancel", text: "Cancel" },
                    {
                      style: "destructive",
                      text: "Reset link",
                      onPress: () => run(() => reset(state.invite.expiresInDays)),
                    },
                  ])
                }
                tone="danger"
              />
            </>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  code: {
    alignSelf: "center",
    backgroundColor: "#f5f4f2",
    borderRadius: radius.md,
    padding: space[8],
  },
  copy: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  expiry: { gap: space[8] },
  grow: { flex: 1, minWidth: 0 },
  heading: { gap: space[6] },
  link: {
    ...material.control,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[8],
    paddingLeft: space[12],
    paddingRight: space[4],
  },
  loading: { marginVertical: space[40] },
  page: { alignSelf: "center", gap: space[18], maxWidth: 560, padding: space[20], width: "100%" },
  segment: {
    alignItems: "center",
    borderRadius: radius.sm,
    flex: 1,
    justifyContent: "center",
    minHeight: touchTarget - 4,
  },
  segmentChosen: { ...material.selected },
  segments: {
    ...material.plate,
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[4],
    padding: space[4],
  },
});
