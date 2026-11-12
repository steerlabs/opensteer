import {
  hostedTeamsDomain,
  type HostedTeamId,
  type HostedTeamSlug,
  type HostedTeamView,
} from "@opensteer/control-plane-protocol/hosted-teams";
import type { TeamConnectionIntent, TeamSessionSnapshot } from "@opensteer/client/team";
import { DeploymentIdSchema } from "@opensteer/core";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { navigationRef } from "../navigation-ref.js";
import type { RootParamList } from "../navigation.js";
import {
  color,
  controlFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
  type,
} from "../theme.js";
import { PersonalTeamLinks } from "@opensteer/client/host";
import {
  useMobileClient,
  useMobileState,
  useSelectedHostClient,
} from "../ui/mobile-client-context.js";
import { appear, exit } from "../ui/motion.js";
import { AppText, Field, PrimaryButton, SecondaryButton, StatusDot } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { openTeamGeneral } from "./mobile-team-entry.js";
import {
  availabilityHint,
  createRefusal,
  localAddressHint,
  slugFromName,
  slugFromTyping,
} from "@opensteer/client/team";
import {
  useAgentIntent,
  useCoordinatorSnapshot,
  useMobileTeams,
  useTeamEntry,
} from "./team-context.js";

type Navigation = NativeStackNavigationProp<RootParamList>;

const selfHostGuide = "https://github.com/steerlabs/opensteer/tree/main/deploy/team";

function failureText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The computer whose agent a new or joined team connects: the one the phone is showing. */
function usePersonalDeploymentId(): string | null {
  return useMobileState().selection.deploymentId;
}

/**
 * Teams, for someone who has none yet or wants another: create one Opensteer hosts, or
 * join with an invite. Running a team server yourself is a quiet link at the foot.
 */
export function TeamsScreen(): ReactNode {
  const navigation = useNavigation<Navigation>();
  const { hostedTeams } = useCoordinatorSnapshot();
  const insets = useSafeAreaInsets();
  const [link, setLink] = useState("");
  const settingUp = hostedTeams.filter((team) => team.stage !== "ready");
  const join = (): void => {
    const value = link.trim();
    if (value === "") return;
    navigation.navigate("JoinTeam", { link: value });
  };
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + space[24] }]}
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      style={styles.ground}
    >
      <View style={styles.column}>
        <AppText role="secondary" tone="soft">
          Chat with your team in channels. Everyone brings their own agent, and it only works when
          its owner asks.
        </AppText>
        {settingUp.map((team) => (
          <SetupRow key={team.id} team={team} />
        ))}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <View style={styles.tileIcon}>
              <Symbol name="plus" size={20} tint={color.ember} />
            </View>
            <View style={styles.grow}>
              <AppText role="title">Create a team</AppText>
              <AppText role="secondary" tone="muted">
                Opensteer hosts it. Ready in about a minute.
              </AppText>
            </View>
          </View>
          <PrimaryButton label="Create" onPress={() => navigation.navigate("CreateTeam")} />
        </View>
        <View style={styles.card}>
          <View>
            <AppText role="title">Have an invite?</AppText>
            <AppText role="secondary" tone="muted">
              Paste the link someone sent you.
            </AppText>
          </View>
          <TextInput
            accessibilityLabel="Invite link"
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            maxFontSizeMultiplier={controlFontScaleLimit}
            onChangeText={setLink}
            onSubmitEditing={join}
            placeholder={`https://acme.${hostedTeamsDomain}/invite/…`}
            placeholderTextColor={color.muted}
            returnKeyType="go"
            selectionColor={color.ember}
            style={styles.input}
            value={link}
          />
          <SecondaryButton disabled={link.trim() === ""} label="Join" onPress={join} />
        </View>
        <Pressable
          accessibilityRole="link"
          hitSlop={space[8]}
          onPress={() => void Linking.openURL(selfHostGuide)}
          style={styles.quietLink}
        >
          <AppText role="caption" tone="muted">
            Prefer your own server?{" "}
            <AppText role="caption" tone="ember">
              Run your own team server
            </AppText>
          </AppText>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/** A team still being set up: where it stands, and the way back to its progress. */
export function SetupRow(props: {
  readonly team: HostedTeamView;
  readonly compact?: boolean;
}): ReactNode {
  const { team } = props;
  const failed = team.stage === "failed";
  return (
    <Pressable
      accessibilityHint="Shows its setup"
      accessibilityLabel={`${team.name}, ${failed ? "setup failed" : "setting up"}`}
      accessibilityRole="button"
      onPress={() => navigationRef.navigate("TeamSetup", { hostedTeamId: team.id })}
      style={({ pressed }) => [styles.setupRow, pressed && styles.pressed]}
    >
      {failed ? (
        <Symbol name="exclamationmark.triangle.fill" size={16} tint={color.amber} />
      ) : (
        <ActivityIndicator color={color.muted} size="small" />
      )}
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        numberOfLines={1}
        role="body"
        style={styles.grow}
      >
        {failed ? `${team.name} didn't finish` : `Setting up ${team.name}`}
      </AppText>
      <Symbol name="chevron.right" size={13} tint={color.muted} />
    </Pressable>
  );
}

/** Name, then address (derived from the name until it is edited), checked as it is typed. */
export function CreateTeamScreen(): ReactNode {
  const navigation = useNavigation<Navigation>();
  const { account, coordinator } = useTeamEntry();
  const personal = usePersonalDeploymentId();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [edited, setEdited] = useState(false);
  const [answer, setAnswer] = useState<{
    readonly slug: string;
    readonly ok: boolean;
    readonly hint: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const local = localAddressHint(slug);
  useEffect(() => {
    if (local !== null) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void account.hostedTeamAvailability(slug, controller.signal).then(
        (result) => setAnswer({ slug, ok: result.available, hint: availabilityHint(slug, result) }),
        () => setAnswer({ slug, ok: false, hint: "The address couldn't be checked. Try again." }),
      );
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [account, local, slug]);
  const checked = local === null && answer?.slug === slug ? answer : null;
  const hint = local?.hint ?? checked?.hint ?? `Checking ${slug}.${hostedTeamsDomain}…`;
  const hintTone =
    local !== null && slug !== ""
      ? "danger"
      : checked === null
        ? "muted"
        : checked.ok
          ? "green"
          : "danger";
  const ready = name.trim() !== "" && checked?.ok === true;
  const create = (): void => {
    if (!ready) return;
    setBusy(true);
    setFailure(null);
    void coordinator
      .createHostedTeam({
        name: name.trim(),
        slug: slug as HostedTeamSlug,
        personalDeploymentId: personal === null ? null : DeploymentIdSchema.parse(personal),
      })
      .then(
        (view) => navigation.replace("TeamSetup", { hostedTeamId: view.id }),
        (error: unknown) => {
          setBusy(false);
          setFailure(createRefusal(error));
        },
      );
  };
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + space[20] }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <AppText role="displaySmall">Create a team</AppText>
        <AppText role="secondary" tone="muted">
          You'll be its owner. Opensteer runs the team server for you.
        </AppText>
      </View>
      <Field
        input={{
          autoCapitalize: "words",
          autoFocus: true,
          onChangeText: (next) => {
            setName(next);
            if (!edited) setSlug(slugFromName(next));
          },
          placeholder: "Acme",
          returnKeyType: "next",
          value: name,
        }}
        label="Team name"
      />
      <View style={styles.field}>
        <Field
          input={{
            autoCapitalize: "none",
            autoCorrect: false,
            onChangeText: (next) => {
              setEdited(true);
              setSlug(slugFromTyping(next));
            },
            onSubmitEditing: create,
            placeholder: "acme",
            returnKeyType: "go",
            value: slug,
          }}
          label="Address"
          trailing={
            <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondary" tone="muted">
              .{hostedTeamsDomain}
            </AppText>
          }
        />
        <AppText
          accessibilityLabel={hint}
          role="caption"
          style={hintTone === "green" ? styles.available : undefined}
          tone={hintTone === "danger" ? "danger" : hintTone === "green" ? "default" : "muted"}
        >
          {hint}
        </AppText>
      </View>
      <AppText role="caption" tone="muted">
        Team chat, files and knowledge live on Opensteer's servers. Everyone's agents, files and
        logins stay on their own computers.
      </AppText>
      {failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {failure}
        </AppText>
      )}
      <View style={styles.buttons}>
        <PrimaryButton
          busy={busy}
          disabled={!ready}
          label="Create team"
          onPress={create}
          prominent
        />
        <SecondaryButton label="Cancel" onPress={() => navigation.goBack()} />
      </View>
    </ScrollView>
  );
}

export interface SetupStep {
  readonly label: string;
  readonly state: "done" | "active" | "waiting";
}

/** The three real stages a person waits on, from Account's stage and the agent's connection. */
export function setupSteps(view: HostedTeamView): readonly SetupStep[] {
  const at =
    view.stage === "reserving"
      ? 0
      : view.stage === "starting" || view.stage === "configuring"
        ? 1
        : 2;
  return [
    `Reserving ${view.slug}.${hostedTeamsDomain}`,
    "Starting your team server",
    "Connecting your agent",
  ].map((label, index) => ({
    label,
    state: index < at ? "done" : index === at ? "active" : "waiting",
  }));
}

/**
 * "Setting up <team>". Closing it, or Keep working, leaves a progress row in the drawer and a
 * notice when the team is ready; staying lands in #general as soon as it is.
 */
export function TeamSetupScreen(
  props: StaticScreenProps<{ readonly hostedTeamId: string }>,
): ReactNode {
  const id = props.route.params.hostedTeamId as HostedTeamId;
  const navigation = useNavigation<Navigation>();
  const { coordinator } = useTeamEntry();
  const { hostedTeams } = useCoordinatorSnapshot();
  const insets = useSafeAreaInsets();
  const view = hostedTeams.find((team) => team.id === id) ?? null;
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      coordinator.watch(id);
      // Swiped away is the same as Keep working.
      return () => coordinator.keepWorking(id);
    }, [coordinator, id]),
  );
  // Gone without opening (cancelled elsewhere, or already entered): nothing left to show.
  const seen = useRef(false);
  useEffect(() => {
    if (view !== null) seen.current = true;
    else if (seen.current && navigation.isFocused()) navigation.goBack();
  }, [navigation, view]);
  if (view === null)
    return (
      <View style={[styles.sheet, styles.center]}>
        <ActivityIndicator color={color.muted} />
      </View>
    );
  const failed = view.stage === "failed";
  const cancel = (): void =>
    Alert.alert(
      `Cancel ${view.name}?`,
      `${view.slug}.${hostedTeamsDomain} is released and nothing is kept.`,
      [
        { style: "cancel", text: "Keep it" },
        {
          style: "destructive",
          text: "Cancel setup",
          onPress: () => {
            setBusy("cancel");
            void coordinator.deleteHostedTeam(id).then(
              () => navigation.goBack(),
              (error: unknown) => {
                setBusy(null);
                setFailure(failureText(error, "Setup couldn't be cancelled."));
              },
            );
          },
        },
      ],
    );
  return (
    <ScrollView
      contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + space[20] }]}
    >
      <View style={styles.heading}>
        <AppText role="displaySmall">
          {failed ? `${view.name} didn't finish` : `Setting up ${view.name}`}
        </AppText>
        <AppText role="secondary" tone="muted">
          {failed
            ? (view.error?.message ?? "Setup stopped before the team was ready.")
            : view.stage === "deleting"
              ? "Cancelling…"
              : "About a minute. You can keep working; we'll tell you when it's ready."}
        </AppText>
      </View>
      {failed ? null : (
        <View accessibilityRole="progressbar" style={styles.steps}>
          {setupSteps(view).map((step) => (
            <View
              accessibilityLabel={`${step.label}, ${step.state === "done" ? "done" : step.state === "active" ? "in progress" : "waiting"}`}
              key={step.label}
              style={styles.step}
            >
              {step.state === "done" ? (
                <Symbol name="checkmark" size={14} tint={color.green} />
              ) : (
                <View style={styles.stepDot}>
                  <StatusDot
                    live={step.state === "active"}
                    tone={step.state === "active" ? "ember" : "muted"}
                  />
                </View>
              )}
              <AppText
                role={step.state === "active" ? "bodyMedium" : "body"}
                tone={
                  step.state === "waiting" ? "muted" : step.state === "done" ? "soft" : "default"
                }
              >
                {step.label}
              </AppText>
            </View>
          ))}
        </View>
      )}
      {failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {failure}
        </AppText>
      )}
      <View style={styles.buttons}>
        {failed ? (
          <PrimaryButton
            busy={busy === "retry"}
            label="Try again"
            onPress={() => {
              setBusy("retry");
              setFailure(null);
              void coordinator
                .retryHostedTeam(id)
                .catch((error: unknown) =>
                  setFailure(failureText(error, "Setup couldn't restart.")),
                )
                .finally(() => setBusy(null));
            }}
            prominent
          />
        ) : (
          <PrimaryButton
            label="Keep working"
            onPress={() => {
              coordinator.keepWorking(id);
              navigation.goBack();
            }}
            prominent
          />
        )}
        <SecondaryButton
          busy={busy === "cancel"}
          disabled={view.stage === "deleting"}
          label="Cancel setup"
          onPress={cancel}
          tone="danger"
        />
      </View>
    </ScrollView>
  );
}

/**
 * "<team> is ready", over whatever the person kept working on. Open lands in #general; the
 * notice also goes once dismissed.
 */
export function TeamReadyNotices(): ReactNode {
  const { coordinator } = useTeamEntry();
  const { ready } = useCoordinatorSnapshot();
  const client = useMobileClient();
  const teams = useMobileTeams();
  const insets = useSafeAreaInsets();
  const notice = ready[0];
  if (notice === undefined) return null;
  return (
    <View pointerEvents="box-none" style={[styles.noticeLayer, { top: insets.top + space[8] }]}>
      <Animated.View
        accessibilityLiveRegion="polite"
        entering={appear}
        exiting={exit}
        key={notice.hostedTeamId}
        style={styles.notice}
      >
        <Symbol name="checkmark.circle.fill" size={18} tint={color.green} />
        <AppText
          maxFontSizeMultiplier={controlFontScaleLimit}
          numberOfLines={1}
          role="bodyMedium"
          style={styles.grow}
        >
          {notice.name} is ready
        </AppText>
        <Pressable
          accessibilityRole="button"
          hitSlop={space[6]}
          onPress={() => {
            coordinator.dismissReady(notice.hostedTeamId);
            void openTeamGeneral(client, teams, notice.teamDeploymentId).catch(() => undefined);
          }}
          style={styles.noticeAction}
        >
          <AppText
            maxFontSizeMultiplier={controlFontScaleLimit}
            role="secondaryMedium"
            tone="ember"
          >
            Open
          </AppText>
        </Pressable>
        <Pressable
          accessibilityLabel="Dismiss"
          accessibilityRole="button"
          hitSlop={space[6]}
          onPress={() => coordinator.dismissReady(notice.hostedTeamId)}
          style={styles.noticeAction}
        >
          <Symbol name="xmark" size={13} tint={color.muted} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * The person's agent in one team: what this phone asked for (the intent), and whether the
 * computer being shown already holds a live link (a team joined before intents existed).
 */
export function useAgentConnection(teamId: string): {
  readonly intent: TeamConnectionIntent | null;
  readonly linked: boolean;
  readonly computerName: string | null;
} {
  const intent = useAgentIntent(teamId);
  const personal = useSelectedHostClient();
  const [linked, setLinked] = useState(false);
  const state = intent?.state ?? null;
  useEffect(() => {
    if (personal === null) return;
    let current = true;
    void new PersonalTeamLinks(personal.rpc).list().then(
      (links) => {
        if (current)
          setLinked(links.some((row) => row.teamId === teamId && row.state === "active"));
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [personal, teamId, state]);
  return {
    intent,
    linked,
    computerName: personal === null ? null : (personal.getSnapshot().ownerName ?? null),
  };
}

/** Type the team's name to delete it: everything in it goes, for everyone. */
export function DeleteTeamScreen(props: StaticScreenProps<{ readonly teamId: string }>): ReactNode {
  const { teamId } = props.route.params;
  const navigation = useNavigation<Navigation>();
  const { coordinator } = useTeamEntry();
  const teams = useMobileTeams();
  const team = teams.team(teamId);
  const hostedTeamId = team?.session?.getSnapshot().bootstrap?.hostedTeamId ?? null;
  const insets = useSafeAreaInsets();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = team?.name ?? "this team";
  const matches = typed.trim() === name;
  const remove = (): void => {
    if (!matches || hostedTeamId === null) return;
    setBusy(true);
    setFailure(null);
    void coordinator
      .deleteHostedTeam(hostedTeamId)
      .then(() => teams.forget(teamId))
      .then(
        () => navigation.popToTop(),
        (error: unknown) => {
          setBusy(false);
          setFailure(failureText(error, "The team wasn't deleted."));
        },
      );
  };
  return (
    <ScrollView
      automaticallyAdjustKeyboardInsets
      contentContainerStyle={[styles.sheet, { paddingBottom: insets.bottom + space[20] }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.heading}>
        <AppText role="displaySmall">Delete {name}?</AppText>
        <AppText role="secondary" tone="muted">
          Its channels, messages, files and knowledge are deleted for everyone, and{" "}
          {team === null ? "its address" : new URL(team.origin).host} stops working. Everyone's own
          agents, tasks and files stay on their computers.
        </AppText>
      </View>
      <Field
        input={{
          autoCapitalize: "none",
          autoCorrect: false,
          autoFocus: true,
          onChangeText: setTyped,
          onSubmitEditing: remove,
          placeholder: name,
          value: typed,
        }}
        label={`Type ${name} to confirm`}
      />
      {failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {failure}
        </AppText>
      )}
      <View style={styles.buttons}>
        <SecondaryButton
          busy={busy}
          disabled={!matches || hostedTeamId === null}
          label={`Delete ${name}`}
          onPress={remove}
          tone="danger"
        />
        <SecondaryButton label="Cancel" onPress={() => navigation.goBack()} />
      </View>
    </ScrollView>
  );
}

/** What the welcome card and team settings say about the person's agent in one team. */
export function agentWords(
  asked: TeamConnectionIntent | null,
  linked: boolean,
  handle: string | null,
): { readonly line: string; readonly tone: "done" | "busy" | "waiting" | "failed" | "none" } {
  const intent = asked?.state === "no-agent" ? null : asked;
  const mention = handle === null ? "@your agent" : `@${handle}-agent`;
  if (intent?.state === "connected" || (intent === null && linked))
    return {
      line: `Your agent is connected. Mention ${mention} in a thread to ask it; it runs on your computer and only acts when you ask.`,
      tone: "done",
    };
  if (intent?.state === "connecting") return { line: "Connecting your agent…", tone: "busy" };
  if (intent?.state === "pending-offline")
    return { line: "Your agent will connect when your computer is online.", tone: "waiting" };
  if (intent?.state === "failed")
    return { line: intent.failure ?? "Your agent couldn't connect.", tone: "failed" };
  return { line: "Your agent isn't connected to this team.", tone: "none" };
}

/** The welcome card for one team, wired to its agent connection and invites. */
export function GeneralWelcome(props: {
  readonly teamId: string;
  readonly teamName: string;
  readonly bootstrap: Pick<NonNullable<TeamSessionSnapshot["bootstrap"]>, "member" | "can">;
}): ReactNode {
  const navigation = useNavigation<Navigation>();
  const { coordinator } = useTeamEntry();
  const teams = useMobileTeams();
  const personal = usePersonalDeploymentId();
  const agent = useAgentConnection(props.teamId);
  const { member, can } = props.bootstrap;
  return (
    <TeamWelcomeCard
      agent={agentWords(agent.intent, agent.linked, member.handle)}
      canInvite={can.manageInvites}
      onConnect={() => {
        const team = teams.team(props.teamId);
        if (agent.intent === null || personal === null || team === null) {
          navigation.navigate("ConnectOpensteer", { teamId: props.teamId });
          return;
        }
        void coordinator
          .connectAgent({
            teamDeploymentId: DeploymentIdSchema.parse(props.teamId),
            origin: team.origin,
            personalDeploymentId: DeploymentIdSchema.parse(personal),
          })
          .catch(() => undefined);
      }}
      onInvite={() => navigation.navigate("TeamInvites", { teamId: props.teamId })}
      owner={member.role === "owner"}
      teamName={props.teamName}
    />
  );
}

/**
 * At the start of #general while the team is new: who you are here, your agent, and for
 * people who can, inviting the team.
 */
export function TeamWelcomeCard(props: {
  readonly teamName: string;
  readonly owner: boolean;
  readonly canInvite: boolean;
  readonly agent: ReturnType<typeof agentWords>;
  readonly onInvite: () => void;
  readonly onConnect: () => void;
}): ReactNode {
  const { agent } = props;
  return (
    <View style={styles.welcome}>
      <AppText role="title">
        {props.owner ? `${props.teamName} is ready` : `Welcome to ${props.teamName}`}
      </AppText>
      <View style={styles.welcomeLine}>
        <Symbol name="checkmark" size={15} tint={color.green} />
        <AppText role="secondary" style={styles.grow} tone="soft">
          {props.owner ? "You're the owner." : "You joined as a member."}
        </AppText>
      </View>
      <View style={styles.welcomeLine}>
        {agent.tone === "done" ? (
          <Symbol name="checkmark" size={15} tint={color.green} />
        ) : agent.tone === "busy" ? (
          <ActivityIndicator color={color.muted} size="small" />
        ) : (
          <View style={styles.stepDot}>
            <StatusDot ring tone={agent.tone === "failed" ? "red" : "muted"} />
          </View>
        )}
        <View style={styles.grow}>
          <AppText role="secondary" tone={agent.tone === "failed" ? "danger" : "soft"}>
            {agent.line}
          </AppText>
          {agent.tone === "failed" || agent.tone === "none" ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={space[8]}
              onPress={props.onConnect}
              style={styles.inlineAction}
            >
              <AppText role="secondaryMedium" tone="ember">
                {agent.tone === "failed" ? "Try again" : "Connect your agent"}
              </AppText>
            </Pressable>
          ) : null}
        </View>
      </View>
      {props.canInvite ? (
        <View style={styles.welcomeLine}>
          <View style={styles.stepDot}>
            <StatusDot ring tone="muted" />
          </View>
          <AppText role="secondary" style={styles.grow} tone="soft">
            Invite your team
          </AppText>
          <PrimaryButton compact label="Invite people" onPress={props.onInvite} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  available: { color: color.green },
  buttons: { gap: space[8] },
  card: {
    ...material.plate,
    borderRadius: radius.lg,
    gap: space[14],
    padding: space[18],
  },
  cardHead: { alignItems: "center", flexDirection: "row", gap: space[12] },
  center: { alignItems: "center", justifyContent: "center", minHeight: 200 },
  column: { alignSelf: "center", gap: space[16], maxWidth: 560, width: "100%" },
  field: { gap: space[6] },
  ground: { backgroundColor: color.background },
  grow: { flex: 1, minWidth: 0 },
  heading: { gap: space[6] },
  inlineAction: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  input: {
    ...type.body,
    ...material.control,
    borderRadius: radius.md,
    color: color.text,
    minHeight: touchTarget,
    paddingHorizontal: space[12],
  },
  notice: {
    ...material.float,
    alignItems: "center",
    alignSelf: "center",
    borderRadius: radius.lg,
    flexDirection: "row",
    gap: space[10],
    maxWidth: 480,
    paddingLeft: space[14],
    paddingRight: space[6],
    width: "100%",
  },
  noticeAction: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  noticeLayer: { left: space[12], position: "absolute", right: space[12] },
  page: { padding: space[16] },
  pressed: { backgroundColor: color.surfacePressed },
  quietLink: { alignSelf: "center", justifyContent: "center", minHeight: touchTarget },
  setupRow: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.md,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[8],
    paddingHorizontal: space[14],
  },
  sheet: { gap: space[18], padding: space[20] },
  step: { alignItems: "center", flexDirection: "row", gap: space[12], minHeight: 28 },
  stepDot: { alignItems: "center", height: 20, justifyContent: "center", width: 20 },
  steps: { gap: space[10] },
  tileIcon: {
    alignItems: "center",
    backgroundColor: color.emberWash,
    borderRadius: radius.sm,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  welcome: {
    ...material.plate,
    borderRadius: radius.lg,
    gap: space[12],
    marginBottom: space[16],
    marginHorizontal: space[16],
    padding: space[16],
  },
  welcomeLine: { alignItems: "flex-start", flexDirection: "row", gap: space[10] },
});
