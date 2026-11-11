import { memo, type ReactNode } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import {
  color,
  controlFontScaleLimit,
  deploymentPaint,
  material,
  radius,
  space,
} from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import type { FaceView, PersonView, TeamTileView } from "./team-models.js";

/**
 * The small marks every team screen shares: a team's tile, a person's face, a
 * person's agent (their face with the Opensteer orb in its corner), and the
 * People only badge. All are decoration to a screen reader: the row beside
 * each mark says the name.
 */

const tones = Object.values(deploymentPaint);

/** A stable colour for an id, so a person or team looks the same on every screen. */
export function toneFor(id: string): (typeof tones)[number] {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) | 0;
  return tones[Math.abs(hash) % tones.length]!;
}

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

export const TeamTile = memo(function TeamTile(props: {
  readonly team: TeamTileView;
  readonly size: 16 | 20 | 24 | 56;
}): ReactNode {
  const tone = toneFor(props.team.id);
  const corner = props.size === 56 ? 14 : props.size === 24 ? 7 : props.size === 20 ? 6 : 5;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        material.mark,
        {
          backgroundColor: tone.fill,
          borderRadius: corner,
          height: props.size,
          width: props.size,
        },
      ]}
    >
      {props.team.imageUri === null ? (
        <Text
          allowFontScaling={false}
          style={[styles.tileLetter, { color: tone.ink, fontSize: props.size * 0.5 }]}
        >
          {initial(props.team.name)}
        </Text>
      ) : (
        <Image source={{ uri: props.team.imageUri }} style={StyleSheet.absoluteFill} />
      )}
    </View>
  );
});

type AvatarSize = 18 | 24 | 28 | 36;

/** A person's face, with the orb in its corner when it stands for their agent. */
export const Avatar = memo(function Avatar(props: {
  readonly person: PersonView;
  readonly size: AvatarSize;
  readonly agent?: boolean;
  /** Show the presence dot; only avatars on screen follow presence. */
  readonly presence?: boolean;
  /** The ground the face sits on, which its badges cut into. */
  readonly ground?: string;
}): ReactNode {
  const { person, size } = props;
  const tone = toneFor(person.id);
  const ground = props.ground ?? color.background;
  const badge = size >= 28 ? 14 : 10;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: size, width: size }}
    >
      <View
        style={[
          styles.face,
          material.mark,
          { backgroundColor: tone.fill, borderRadius: size / 2, height: size, width: size },
        ]}
      >
        {person.avatarUri === null ? (
          <Text
            allowFontScaling={false}
            style={[styles.faceLetter, { color: tone.ink, fontSize: size * 0.42 }]}
          >
            {initial(person.name)}
          </Text>
        ) : (
          <Image source={{ uri: person.avatarUri }} style={StyleSheet.absoluteFill} />
        )}
      </View>
      {props.agent === true ? (
        <View
          style={[
            styles.badge,
            {
              backgroundColor: ground,
              borderRadius: badge / 2 + 2,
              height: badge + 4,
              right: -3,
              bottom: -3,
              width: badge + 4,
            },
          ]}
        >
          <AgentOrb size={badge} />
        </View>
      ) : props.presence === true && person.presence !== null ? (
        <View
          style={[
            styles.presence,
            { borderColor: ground },
            person.presence === "active" ? styles.presenceActive : styles.presenceAway,
          ]}
        />
      ) : null}
    </View>
  );
});

/** The Opensteer orb at any size: an agent's mark wherever one appears. */
export function AgentOrb(props: { readonly size: number }): ReactNode {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ height: props.size, width: props.size }}
    >
      <Image
        resizeMode="contain"
        source={require("../../assets/opensteer.png") as number}
        style={{ height: props.size, width: props.size }}
      />
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, material.mark, { borderRadius: props.size / 2 }]}
      />
    </View>
  );
}

/** Up to three faces, overlapping, for a thread summary or a group DM. */
export function FaceStack(props: {
  readonly faces: readonly FaceView[];
  readonly size: 18 | 24;
  readonly ground?: string;
}): ReactNode {
  const shown = props.faces.slice(0, 3);
  return (
    <View style={styles.stack}>
      {shown.map((face, index) => (
        <View
          key={`${face.kind}:${face.kind === "person" ? face.person.id : face.owner.id}`}
          style={[
            styles.stacked,
            {
              borderColor: props.ground ?? color.background,
              borderRadius: props.size,
              marginLeft: index === 0 ? 0 : -props.size / 3,
            },
          ]}
        >
          <Avatar
            agent={face.kind === "agent"}
            ground={props.ground ?? color.background}
            person={face.kind === "person" ? face.person : face.owner}
            size={props.size}
          />
        </View>
      ))}
    </View>
  );
}

/** "People only", always in the same words and the same blue. */
export function PeopleOnlyBadge(props: { readonly compact?: boolean }): ReactNode {
  if (props.compact === true) {
    return <Symbol accessibilityLabel="People only" name="person" size={14} tint={color.blue} />;
  }
  return (
    <View style={styles.peopleOnly}>
      <Symbol name="person" size={12} tint={color.blue} weight="semibold" />
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.peopleOnlyText}
      >
        People only
      </AppText>
    </View>
  );
}

export const peopleOnlySentence =
  "Your agent can do whatever you can, unless the thing is marked people only.";

/** A channel's glyph: # for public, a lock for private. */
export function ChannelGlyph(props: {
  readonly kind: "public" | "private";
  readonly size?: number;
  readonly tint?: string;
}): ReactNode {
  return (
    <Symbol
      name={props.kind === "private" ? "lock" : "number"}
      size={props.size ?? 16}
      tint={props.tint ?? color.muted}
      weight="medium"
    />
  );
}

/** Mentions of the reader: an ember count. Never an unread total. */
export function MentionCount(props: { readonly count: number }): ReactNode {
  if (props.count <= 0) return null;
  return (
    <View style={styles.count}>
      <AppText
        maxFontSizeMultiplier={controlFontScaleLimit}
        role="caption"
        style={styles.countText}
      >
        {props.count > 99 ? "99+" : String(props.count)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { alignItems: "center", justifyContent: "center", position: "absolute" },
  count: {
    alignItems: "center",
    backgroundColor: color.ember,
    borderRadius: radius.full,
    justifyContent: "center",
    minWidth: 20,
    paddingHorizontal: space[6],
  },
  countText: { color: color.inkOnEmber, fontVariant: ["tabular-nums"], fontWeight: "700" },
  face: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  faceLetter: { fontWeight: "600" },
  peopleOnly: {
    alignItems: "center",
    alignSelf: "flex-start",
    backgroundColor: color.blueWash,
    borderColor: color.blueLine,
    borderRadius: radius.full,
    borderWidth: 1,
    flexDirection: "row",
    gap: space[4],
    paddingHorizontal: space[8],
    paddingVertical: 2,
  },
  peopleOnlyText: { color: color.blue, fontWeight: "600" },
  presence: {
    borderRadius: radius.full,
    borderWidth: 2,
    bottom: -2,
    height: 10,
    position: "absolute",
    right: -2,
    width: 10,
  },
  presenceActive: { backgroundColor: color.green },
  presenceAway: { backgroundColor: color.surfaceRaised },
  stack: { flexDirection: "row" },
  stacked: { borderWidth: 2 },
  tile: { alignItems: "center", justifyContent: "center", overflow: "hidden" },
  tileLetter: { fontWeight: "700" },
});
