import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { color, controlFontScaleLimit, radius, space, touchTarget } from "../theme.js";
import { AppText, PrimaryButton, RowGroup, SecondaryButton } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { AgentOrb, TeamTile } from "./team-marks.js";
import type { TeamTileView } from "./team-models.js";

/** What an invite link turned out to be, as the join sheet shows it. */
export type InviteView =
  | { readonly kind: "checking" }
  | {
      readonly kind: "ready";
      readonly team: TeamTileView;
      /** "acme.teams.opensteer.com". */
      readonly host: string;
      /** "Maya Chen", once the team has said; an invite read before sign-in names nobody. */
      readonly inviter: string | null;
      /** The Opensteer Account the reader joins as: "you@example.com". */
      readonly joinAs: string;
      readonly joining: boolean;
      /**
       * The reader's computers, when there is more than one to choose from:
       * the one chosen is whose agent the team can ask, and whose drawer the
       * team joins.
       */
      readonly computers: readonly { readonly id: string; readonly name: string }[];
      readonly computerId: string | null;
    }
  | {
      readonly kind: "no-longer-works";
      readonly team: TeamTileView;
      readonly inviter: string | null;
    }
  /** An older team: the person joins on its invite page in the browser, then comes back. */
  | { readonly kind: "in-browser"; readonly team: TeamTileView }
  | { readonly kind: "already-member"; readonly team: TeamTileView }
  | { readonly kind: "update-app"; readonly team: TeamTileView }
  | { readonly kind: "update-server"; readonly team: TeamTileView }
  | { readonly kind: "unreachable"; readonly host: string }
  | { readonly kind: "failed"; readonly detail: string };

/**
 * The sheet an invite link opens over Home. Joining puts the team in the
 * drawer on every device the reader uses and opens its first channel. Every
 * way it can't work says why and what to do next.
 */
export function JoinSheetBody(props: {
  readonly invite: InviteView;
  readonly onChooseComputer: (computerId: string) => void;
  readonly onJoin: () => void;
  /** Back from joining in the browser. */
  readonly onContinue: () => void;
  readonly onClose: () => void;
  readonly onOpenTeam: () => void;
  readonly onUpdate: () => void;
  readonly onRetry: () => void;
}): ReactNode {
  const { invite } = props;
  switch (invite.kind) {
    case "checking":
      return (
        <View style={[styles.sheet, styles.center]}>
          <ActivityIndicator color={color.muted} />
          <AppText role="secondary" tone="muted">
            Opening the invite…
          </AppText>
        </View>
      );
    case "ready":
      return (
        <View style={styles.sheet}>
          <View style={styles.hero}>
            <TeamTile size={56} team={invite.team} />
            <AppText role="displaySmall" style={styles.centerText}>
              Join {invite.team.name}
            </AppText>
            <AppText role="secondary" style={styles.centerText} tone="muted">
              {[invite.host, invite.inviter === null ? null : `invited by ${invite.inviter}`]
                .filter(Boolean)
                .join(" · ")}
            </AppText>
            <AppText role="secondary" style={styles.fine} tone="soft">
              You'll join as {invite.joinAs}. Your agent will be connected so you can ask it in
              threads. It stays on your computer and only acts when you ask.
            </AppText>
          </View>
          {invite.computers.length < 2 ? null : (
            <View style={styles.choice}>
              <AppText role="secondaryMedium" tone="muted">
                Which computer joins?
              </AppText>
              <RowGroup>
                {invite.computers.map((computer) => {
                  const chosen = computer.id === invite.computerId;
                  return (
                    <Pressable
                      accessibilityLabel={computer.name}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: chosen, disabled: invite.joining }}
                      disabled={invite.joining}
                      key={computer.id}
                      onPress={() => props.onChooseComputer(computer.id)}
                      style={({ pressed }) => [styles.computer, pressed && styles.pressed]}
                    >
                      <Symbol name="laptopcomputer" size={18} tint={color.textSoft} />
                      <AppText
                        maxFontSizeMultiplier={controlFontScaleLimit}
                        numberOfLines={1}
                        role="body"
                        style={styles.grow}
                      >
                        {computer.name}
                      </AppText>
                      {chosen ? <Symbol name="checkmark" size={16} tint={color.ember} /> : null}
                    </Pressable>
                  );
                })}
              </RowGroup>
            </View>
          )}
          <View style={styles.buttons}>
            <PrimaryButton
              busy={invite.joining}
              label={`Join ${invite.team.name}`}
              onPress={props.onJoin}
              prominent
            />
            <SecondaryButton disabled={invite.joining} label="Cancel" onPress={props.onClose} />
          </View>
        </View>
      );
    case "no-longer-works":
      return (
        <Outcome
          action={{ label: "OK", onPress: props.onClose }}
          detail={`Ask ${invite.inviter ?? "someone"}, or anyone who manages ${invite.team.name}, for a new link.`}
          icon="link"
          team={invite.team}
          title="This invite no longer works"
        />
      );
    case "in-browser":
      return (
        <View style={styles.sheet}>
          <View style={styles.hero}>
            <TeamTile size={56} team={invite.team} />
            <AppText role="title" style={styles.centerText}>
              Finish joining in your browser
            </AppText>
            <AppText role="secondary" style={styles.centerText} tone="muted">
              Join {invite.team.name} on the page that opened, then come back here.
            </AppText>
          </View>
          <View style={styles.buttons}>
            <PrimaryButton label="Continue" onPress={props.onContinue} prominent />
            <SecondaryButton label="Cancel" onPress={props.onClose} />
          </View>
        </View>
      );
    case "already-member":
      return (
        <Outcome
          action={{ label: `Open ${invite.team.name}`, onPress: props.onOpenTeam, primary: true }}
          detail="This link is for a team you're already in."
          icon="checkmark.circle"
          team={invite.team}
          title={`You're in ${invite.team.name}`}
        />
      );
    case "update-app":
      return <VersionMismatchBody kind="update-app" onAction={props.onUpdate} team={invite.team} />;
    case "update-server":
      return (
        <VersionMismatchBody kind="update-server" onAction={props.onRetry} team={invite.team} />
      );
    case "unreachable":
      return (
        <Outcome
          action={{ label: "Try again", onPress: props.onRetry, primary: true }}
          detail={`${invite.host} didn't answer. Check you're online, or on the network the team uses, then try again.`}
          icon="exclamationmark.circle"
          team={null}
          title="Can't reach the team"
        />
      );
    case "failed":
      return (
        <Outcome
          action={{ label: "Try again", onPress: props.onRetry, primary: true }}
          detail={invite.detail}
          icon="exclamationmark.circle"
          team={null}
          title="Couldn't join"
        />
      );
  }
}

/**
 * Who is behind says so, and only they act: the reader updates their app,
 * or the team's server updates itself (it checks hourly).
 */
export function VersionMismatchBody(props: {
  readonly kind: "update-app" | "update-server";
  readonly team: TeamTileView;
  /** Update the app, or try again later. */
  readonly onAction: () => void;
}): ReactNode {
  const name = props.team.name;
  return props.kind === "update-app" ? (
    <Outcome
      action={{ label: "Update Opensteer", onPress: props.onAction, primary: true }}
      detail={`${name} runs a newer Opensteer than this app. Update to keep using it; nothing you wrote is lost.`}
      icon="arrow.clockwise"
      team={props.team}
      title={`Update Opensteer to use ${name}`}
    />
  ) : (
    <Outcome
      action={{ label: "Try again", onPress: props.onAction }}
      detail={`${name}'s server is older than this app. It updates itself, usually within the hour.`}
      icon="clock"
      team={props.team}
      title={`${name}'s server needs an update`}
    />
  );
}

function Outcome(props: {
  readonly action: {
    readonly label: string;
    readonly onPress: () => void;
    readonly primary?: boolean;
  };
  readonly detail: string;
  readonly icon: SFSymbolName;
  readonly team: TeamTileView | null;
  readonly title: string;
}): ReactNode {
  return (
    <View style={styles.sheet}>
      <View style={styles.hero}>
        {props.team === null ? (
          <View style={styles.iconDisc}>
            <Symbol name={props.icon} size={24} tint={color.textSoft} />
          </View>
        ) : (
          <TeamTile size={56} team={props.team} />
        )}
        <AppText role="title" style={styles.centerText}>
          {props.title}
        </AppText>
        <AppText role="secondary" style={styles.centerText} tone="muted">
          {props.detail}
        </AppText>
      </View>
      {props.action.primary === true ? (
        <PrimaryButton label={props.action.label} onPress={props.action.onPress} prominent />
      ) : (
        <SecondaryButton label={props.action.label} onPress={props.action.onPress} />
      )}
    </View>
  );
}

/** What can connect the reader's agent to a team, from this phone. */
export type ConnectView =
  | {
      readonly kind: "choose";
      readonly team: TeamTileView;
      /** The reader's own Opensteers this phone knows. */
      readonly computers: readonly { readonly id: string; readonly name: string }[];
      /** Already connected from another computer: connecting here replaces it. */
      readonly connectedElsewhere: string | null;
      readonly connecting: string | null;
      readonly failure: string | null;
    }
  /** No Opensteer of their own: they can chat, but their agent has nowhere to run. */
  | { readonly kind: "no-computer"; readonly team: TeamTileView };

/**
 * "Connect your Opensteer": what asking your agent in a team needs. The team
 * holds no agent; the reader's own Opensteer runs it, on their computer, and
 * this links the two. Without a computer, the reader still chats.
 */
export function ConnectOpensteerBody(props: {
  readonly connect: ConnectView;
  readonly onConnect: (computerId: string) => void;
  readonly onClose: () => void;
  readonly onGetOpensteer: () => void;
}): ReactNode {
  const { connect } = props;
  if (connect.kind === "no-computer") {
    return (
      <View style={styles.sheet}>
        <View style={styles.hero}>
          <AgentOrb size={48} />
          <AppText role="displaySmall" style={styles.centerText}>
            Your agent runs on a computer
          </AppText>
          <AppText role="secondary" style={styles.centerText} tone="muted">
            Set up Opensteer on a Mac or PC to ask your agent here. Until then you can read and
            write in {connect.team.name} like anyone else.
          </AppText>
        </View>
        <View style={styles.buttons}>
          <PrimaryButton
            label="Get Opensteer for your computer"
            onPress={props.onGetOpensteer}
            prominent
          />
          <SecondaryButton label="Not now" onPress={props.onClose} />
        </View>
      </View>
    );
  }
  return (
    <ScrollView contentContainerStyle={styles.sheet}>
      <View style={styles.hero}>
        <AgentOrb size={48} />
        <AppText role="displaySmall" style={styles.centerText}>
          Connect your Opensteer
        </AppText>
        <AppText role="secondary" style={styles.centerText} tone="muted">
          To ask your agent in {connect.team.name}, connect the Opensteer it runs on. Its tasks stay
          on that computer; {connect.team.name} sees only what your agent posts and its live status.
        </AppText>
      </View>
      {connect.connectedElsewhere === null ? null : (
        <View style={styles.warning}>
          <AppText role="caption" style={styles.warningText}>
            Your agent is connected from {connect.connectedElsewhere}. Connecting another computer
            disconnects that one.
          </AppText>
        </View>
      )}
      <RowGroup>
        {connect.computers.map((computer) => (
          <Pressable
            accessibilityLabel={`Connect ${computer.name}`}
            accessibilityRole="button"
            accessibilityState={{
              busy: connect.connecting === computer.id,
              disabled: connect.connecting !== null,
            }}
            disabled={connect.connecting !== null}
            key={computer.id}
            onPress={() => props.onConnect(computer.id)}
            style={({ pressed }) => [styles.computer, pressed && styles.pressed]}
          >
            <Symbol name="laptopcomputer" size={18} tint={color.textSoft} />
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              numberOfLines={1}
              role="body"
              style={styles.grow}
            >
              {computer.name}
            </AppText>
            {connect.connecting === computer.id ? (
              <ActivityIndicator color={color.ember} />
            ) : (
              <AppText role="secondaryMedium" tone="ember">
                Connect
              </AppText>
            )}
          </Pressable>
        ))}
      </RowGroup>
      {connect.failure === null ? null : (
        <AppText role="secondary" tone="danger">
          {connect.failure}
        </AppText>
      )}
      <SecondaryButton label="Not now" onPress={props.onClose} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  buttons: { gap: space[8] },
  center: { alignItems: "center", justifyContent: "center", minHeight: 240 },
  centerText: { textAlign: "center" },
  choice: { gap: space[8] },
  computer: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + 8,
    paddingHorizontal: space[14],
  },
  fine: { maxWidth: 340, textAlign: "center" },
  grow: { flex: 1 },
  hero: {
    alignItems: "center",
    gap: space[10],
    paddingHorizontal: space[8],
    paddingVertical: space[8],
  },
  iconDisc: {
    alignItems: "center",
    backgroundColor: color.surfaceRaised,
    borderRadius: radius.full,
    height: 56,
    justifyContent: "center",
    width: 56,
  },
  pressed: { backgroundColor: color.surfacePressed },
  sheet: { gap: space[20], padding: space[20] },
  warning: {
    backgroundColor: color.amberWash,
    borderColor: color.amberLine,
    borderRadius: radius.md,
    borderWidth: 1,
    padding: space[12],
  },
  warningText: { color: color.amber },
});
