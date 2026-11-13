import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { ComposerDockLayout } from "../thread/composer-dock.js";
import {
  color,
  controlFontScaleLimit,
  headerFontScaleLimit,
  material,
  radius,
  space,
  touchTarget,
} from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { ConnectionBanner } from "./connection-banner.js";
import { MessageRow, wordsInset } from "./message-row.js";
import { ChannelGlyph, FaceStack, PeopleOnlyBadge } from "./team-marks.js";
import { TeamComposer, type TeamComposerProps } from "./team-composer.js";
import type {
  ChannelHeaderView,
  ConnectionBannerView,
  JumpView,
  MessageView,
  TimelineItem,
} from "./team-models.js";
import { ChannelIntro, Timeline, type TimelineActions } from "./timeline.js";

interface PlaceBodyProps {
  readonly actions: TimelineActions;
  readonly banner: ConnectionBannerView | null;
  readonly composer: TeamComposerProps;
  /** Why the reader can't post here, shown in the composer's place; null when they can. */
  readonly closed: string | null;
  readonly items: readonly TimelineItem[];
  readonly jump: JumpView | null;
  /** The message a link named, once it has been loaded. */
  readonly anchorId: string | null;
  readonly typing: string | null;
}

/**
 * A channel, a DM or a group DM: its messages and the composer floating over
 * their foot. The bar above it is the native one; `ChannelTitle` is its title,
 * which opens Details (Members, Files and Pinned live there on a phone).
 *
 * Asks to agents are answered in a thread under the asking message, in DMs as
 * in channels, so this screen shows only roots, their summaries and the
 * replies people post here.
 */
export function ChannelScreenBody(
  props: PlaceBodyProps & {
    readonly channel: ChannelHeaderView;
    /** Nothing older to load: the start of the channel is drawn above its first message. */
    readonly atStart: boolean;
    /** A new team's welcome, at the very start of #general. */
    readonly welcome?: ReactNode;
  },
): ReactNode {
  const { channel } = props;
  return (
    <PlaceLayout {...props}>
      {props.atStart ? (
        <>
          <PlaceStart channel={channel} />
          {props.welcome}
        </>
      ) : null}
    </PlaceLayout>
  );
}

/**
 * A thread, pushed full screen: its root, the count, the replies and any
 * agent's live card. The composer starts "to my agent" when the reader's own
 * agent still has this thread's task open.
 */
export function ThreadScreenBody(
  props: PlaceBodyProps & {
    readonly root: MessageView;
    readonly replyCount: number;
  },
): ReactNode {
  return (
    <PlaceLayout {...props}>
      <View>
        <MessageRow
          actions={props.actions}
          message={{ ...props.root, continued: false, thread: null }}
        />
        {props.replyCount === 0 ? null : (
          <View style={styles.replies}>
            <AppText
              maxFontSizeMultiplier={controlFontScaleLimit}
              role="caption"
              style={styles.repliesLabel}
            >
              {props.replyCount === 1 ? "1 reply" : `${props.replyCount} replies`}
            </AppText>
            <View style={styles.repliesRule} />
          </View>
        )}
      </View>
    </PlaceLayout>
  );
}

function PlaceLayout(props: PlaceBodyProps & { readonly children: ReactNode }): ReactNode {
  return (
    <View style={styles.fill}>
      {props.banner === null ? null : <ConnectionBanner banner={props.banner} />}
      <ComposerDockLayout
        avoidKeyboard
        dock={
          props.closed === null ? (
            <TeamComposer {...props.composer} />
          ) : (
            <View style={styles.closedStack}>
              {props.composer.hint ?? null}
              <View accessibilityRole="text" style={styles.closed}>
                <AppText
                  maxFontSizeMultiplier={controlFontScaleLimit}
                  role="secondary"
                  style={styles.closedText}
                  tone="muted"
                >
                  {props.closed}
                </AppText>
              </View>
            </View>
          )
        }
      >
        {(clearance) => (
          <Timeline
            actions={props.actions}
            clearance={clearance}
            intro={props.children}
            items={props.items}
            anchorId={props.anchorId}
            jump={props.jump}
            typing={props.typing}
          />
        )}
      </ComposerDockLayout>
    </View>
  );
}

function PlaceStart(props: { readonly channel: ChannelHeaderView }): ReactNode {
  const { channel } = props;
  if (channel.kind === "dm" || channel.kind === "group-dm") {
    const names = channel.people.map((person) => person.name);
    return (
      <View style={styles.dmStart}>
        <FaceStack
          faces={channel.people.map((person) => ({ kind: "person" as const, person }))}
          size={24}
        />
        <AppText role="title">{channel.name}</AppText>
        <AppText role="secondary" tone="soft">
          {channel.kind === "dm"
            ? `This is the start of your messages with ${names[0] ?? channel.name}.`
            : `This is the start of your messages with ${names.join(", ")}.`}
        </AppText>
      </View>
    );
  }
  return (
    <ChannelIntro
      description={channel.description}
      instructions={channel.instructions}
      peopleOnly={channel.peopleOnly}
      title={`This is the start of #${channel.name}`}
    />
  );
}

/**
 * The bar's title for a channel or DM: its name, and a quiet second line
 * (member count, or the person's presence).
 */
export function ChannelTitle(props: { readonly channel: ChannelHeaderView }): ReactNode {
  const { channel } = props;
  const dm = channel.kind === "dm" || channel.kind === "group-dm";
  const presence = channel.kind === "dm" ? channel.people[0]?.presence : null;
  const subtitle = dm
    ? presence === "active"
      ? "Active"
      : presence === "away"
        ? "Away"
        : null
    : channel.memberCount === null
      ? null
      : `${channel.memberCount} ${channel.memberCount === 1 ? "member" : "members"}`;
  return (
    <View accessibilityRole="header" style={styles.title}>
      <View style={styles.titleLine}>
        {dm ? null : (
          <ChannelGlyph
            kind={channel.kind === "private" ? "private" : "public"}
            size={15}
            tint={color.textSoft}
          />
        )}
        <AppText maxFontSizeMultiplier={headerFontScaleLimit} numberOfLines={1} role="title">
          {channel.name}
        </AppText>
        {channel.peopleOnly ? <PeopleOnlyBadge compact /> : null}
      </View>
      {subtitle === null ? null : (
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="caption"
          tone="muted"
        >
          {subtitle}
        </AppText>
      )}
    </View>
  );
}

/** The bar's title for a thread: "Thread", and where it lives. */
export function ThreadTitle(props: { readonly place: string }): ReactNode {
  return (
    <View accessibilityRole="header" style={styles.title}>
      <AppText maxFontSizeMultiplier={headerFontScaleLimit} numberOfLines={1} role="title">
        Thread
      </AppText>
      <AppText
        maxFontSizeMultiplier={headerFontScaleLimit}
        numberOfLines={1}
        role="caption"
        tone="muted"
      >
        {props.place}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  closed: {
    ...material.plate,
    alignItems: "center",
    borderRadius: radius.lg,
    justifyContent: "center",
    minHeight: touchTarget + 4,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  closedStack: { gap: space[8] },
  closedText: { textAlign: "center" },
  dmStart: {
    gap: space[6],
    paddingBottom: space[12],
    paddingHorizontal: space[14],
    paddingTop: space[24],
  },
  fill: { backgroundColor: color.background, flex: 1 },
  replies: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[10],
    paddingBottom: space[4],
    paddingLeft: space[14] + wordsInset,
    paddingRight: space[14],
    paddingTop: space[12],
  },
  repliesLabel: { color: color.muted, fontWeight: "600" },
  repliesRule: { backgroundColor: color.line, flex: 1, height: StyleSheet.hairlineWidth },
  title: { alignItems: "center", maxWidth: 240 },
  titleLine: { alignItems: "center", flexDirection: "row", gap: space[4] },
});
