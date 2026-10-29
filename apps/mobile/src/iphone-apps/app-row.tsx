import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { color, space, touchTarget } from "../theme.js";
import { appear } from "../ui/motion.js";
import {
  AppText,
  PrimaryButton,
  RowGroup,
  SecondaryButton,
  SectionLabel,
  StatusDot,
} from "../ui/primitives.js";
import { Sheet } from "../ui/sheet.js";
import { Symbol } from "../ui/symbol.js";
import type { IphoneAccessChoice, IphoneReview, IphoneTone } from "./model.js";

/**
 * One of an iPhone's apps: its name, then a line that says first whether
 * agents can use it now, then the access it has and what limits it. A row that
 * can change opens its sheet; one that cannot is drawn the same, without the
 * chevron.
 */
export function IphoneAppRow(props: {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly line: string;
  readonly name: string;
  readonly onPress?: () => void;
  readonly tone: IphoneTone;
  readonly trailing?: ReactNode;
}): ReactNode {
  const pressable = props.onPress !== undefined && props.disabled !== true;
  return (
    <View style={styles.app}>
      <View style={styles.head}>
        <Pressable
          accessibilityLabel={`${props.name}, ${props.line}`}
          accessibilityRole="button"
          disabled={!pressable}
          onPress={props.onPress}
          style={({ pressed }) => [styles.row, pressed && pressable && styles.pressed]}
        >
          <StatusDot tone={props.tone} />
          <View style={styles.text}>
            <AppText role="body">{props.name}</AppText>
            <AppText role="secondary" tone="muted">
              {props.line}
            </AppText>
          </View>
          {pressable ? <Symbol name="chevron.right" size={13} tint={color.muted} /> : null}
        </Pressable>
        {props.trailing === undefined ? null : (
          <View style={styles.trailing}>{props.trailing}</View>
        )}
      </View>
      {props.children}
    </View>
  );
}

/** The two independent facts behind an app's state, named by who decides each. */
export interface IphoneAccessFacts {
  /** Opensteer's grant to agents. */
  readonly access: string;
  /** What iPhone Settings lets Opensteer do, when this device can know it. */
  readonly permission: string;
}

/**
 * One app's access: what agents can do now and why, the access levels as
 * radio choices, and one review of the chosen change before anything is sent.
 *
 * Choosing a level is only a draft. The current level is marked as such and
 * stays marked; Review appears once the draft differs, and only the review's
 * own button commits. Close at any point sends nothing, and the draft goes
 * with the sheet.
 */
export function IphoneAccessSheet(props: {
  readonly busy: boolean;
  readonly choices: readonly IphoneAccessChoice[];
  readonly facts: IphoneAccessFacts;
  /** Shown above the choices, such as an unverified change and how to check it. */
  readonly header?: ReactNode;
  readonly name: string;
  readonly onClose: () => void;
  readonly onCommit: (choice: IphoneAccessChoice) => void;
  readonly onOpenSettings: (() => void) | null;
  readonly review: (choice: IphoneAccessChoice) => IphoneReview | null;
  readonly summary: { readonly text: string; readonly tone: IphoneTone };
}): ReactNode {
  const current = props.choices.find(({ action }) => action === "current") ?? null;
  const [draft, setDraft] = useState<IphoneAccessChoice["access"] | undefined>(undefined);
  const [reviewing, setReviewing] = useState(false);
  // A draft equal to the current level, including after the Host moved it, is no change.
  const chosen =
    props.choices.find(
      ({ access }) => access === (draft === undefined ? current?.access : draft),
    ) ?? current;
  const pending = chosen !== null && chosen.action !== "current" ? chosen : null;
  const review = reviewing && pending !== null ? props.review(pending) : null;

  return (
    <Sheet onClose={props.onClose} open title={props.name}>
      {review === null || pending === null ? (
        <Animated.View entering={appear} key="choose" style={styles.sheet}>
          <View accessibilityRole="summary" style={styles.summary}>
            <StatusDot tone={props.summary.tone} />
            <AppText role="body" style={styles.text}>
              {props.summary.text}
            </AppText>
          </View>
          <RowGroup>
            <Fact label="Agent access" owner="Opensteer" value={props.facts.access} />
            <Fact label="iPhone Settings" owner="iOS" value={props.facts.permission} />
          </RowGroup>
          {props.header}
          <SectionLabel>Agent access</SectionLabel>
          <View
            accessibilityLabel={`Agent access for ${props.name}`}
            accessibilityRole="radiogroup"
          >
            <RowGroup>
              {props.choices.map((choice) => (
                <AccessOption
                  checked={chosen?.access === choice.access}
                  choice={choice}
                  disabled={props.busy}
                  key={choice.access ?? "off"}
                  onPress={() => {
                    if (chosen?.access === choice.access) return;
                    void Haptics.selectionAsync();
                    setDraft(choice.access);
                  }}
                />
              ))}
            </RowGroup>
          </View>
          {pending === null ? null : (
            <Animated.View entering={appear} style={styles.commit}>
              <AppText role="secondary" tone="muted">
                {`Not changed yet. Current access: ${current?.label ?? "Off"}.`}
              </AppText>
              <PrimaryButton
                disabled={props.busy}
                label="Review"
                onPress={() => setReviewing(true)}
              />
            </Animated.View>
          )}
        </Animated.View>
      ) : (
        <Animated.View entering={appear} key="review" style={styles.sheet}>
          <AppText role="displaySmall">{review.title}</AppText>
          <ReviewBody review={review} />
          <View style={styles.actions}>
            <SecondaryButton label="Back" onPress={() => setReviewing(false)} />
            {review.kind === "blocked" ? (
              props.onOpenSettings === null ? null : (
                <PrimaryButton label="Open Settings" onPress={props.onOpenSettings} />
              )
            ) : review.kind === "allow" ? (
              <PrimaryButton
                busy={props.busy}
                label="Allow"
                onPress={() => props.onCommit(pending)}
              />
            ) : (
              <SecondaryButton
                busy={props.busy}
                label={review.confirm}
                onPress={() => props.onCommit(pending)}
                tone="danger"
              />
            )}
          </View>
        </Animated.View>
      )}
    </Sheet>
  );
}

function ReviewBody(props: { readonly review: IphoneReview }): ReactNode {
  const { review } = props;
  switch (review.kind) {
    case "allow":
      return (
        <>
          <AppText role="body">{review.body}</AppText>
          <AppText role="secondary" tone="soft">
            {review.scope}
          </AppText>
          {review.caveat === null ? null : (
            <AppText role="secondary" tone="soft">
              {review.caveat}
            </AppText>
          )}
          <AppText role="secondary" tone="soft">
            {review.disclosure}
          </AppText>
          {review.keeps === null ? null : (
            <AppText role="secondary" tone="muted">
              {review.keeps}
            </AppText>
          )}
          {review.note === null ? null : (
            <AppText role="secondary" tone="muted">
              {review.note}
            </AppText>
          )}
        </>
      );
    case "blocked":
      return <AppText role="body">{review.body}</AppText>;
    case "lower":
    case "turn-off":
      return (
        <>
          <AppText role="body">{review.body}</AppText>
          <AppText role="secondary" tone="soft">
            {review.undone}
          </AppText>
        </>
      );
  }
}

/** One fact, with whose decision it is, so the two are never read as one. */
function Fact(props: {
  readonly label: string;
  readonly owner: string;
  readonly value: string;
}): ReactNode {
  return (
    <View accessible accessibilityLabel={`${props.label}: ${props.value}`} style={styles.fact}>
      <View style={styles.text}>
        <AppText role="secondaryMedium">{props.label}</AppText>
        <AppText role="caption" tone="muted">
          {`Set by ${props.owner}`}
        </AppText>
      </View>
      <AppText role="secondary" style={styles.factValue} tone="soft">
        {props.value}
      </AppText>
    </View>
  );
}

/**
 * One access level as a native radio row. The current level keeps its
 * "Current" mark whatever is chosen, so the draft and the access agents have
 * now are never the same mark.
 */
function AccessOption(props: {
  readonly checked: boolean;
  readonly choice: IphoneAccessChoice;
  readonly disabled: boolean;
  readonly onPress: () => void;
}): ReactNode {
  const { choice } = props;
  const isCurrent = choice.action === "current";
  return (
    <Pressable
      accessibilityHint={choice.detail}
      accessibilityLabel={isCurrent ? `${choice.label}, current access` : choice.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.checked, disabled: props.disabled }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [styles.option, pressed && styles.pressed]}
    >
      <View style={styles.text}>
        <AppText role="bodyMedium">{choice.label}</AppText>
        <AppText role="secondary" tone="muted">
          {choice.detail}
        </AppText>
      </View>
      {isCurrent ? (
        <AppText role="caption" tone="muted">
          Current
        </AppText>
      ) : null}
      <View style={styles.check}>
        {props.checked ? (
          <Symbol name="checkmark" size={17} tint={color.ember} weight="semibold" />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space[12],
    justifyContent: "flex-end",
    paddingTop: space[8],
  },
  app: { gap: space[4] },
  check: { alignItems: "center", minWidth: space[24] },
  commit: { gap: space[8], paddingTop: space[4] },
  fact: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget,
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  factValue: { flexShrink: 1, textAlign: "right" },
  head: { alignItems: "center", flexDirection: "row" },
  option: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  pressed: { backgroundColor: color.surfacePressed },
  row: {
    alignItems: "center",
    flex: 1,
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[12],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  sheet: { gap: space[12], paddingHorizontal: space[16], paddingTop: space[8] },
  summary: { alignItems: "center", flexDirection: "row", gap: space[10] },
  text: { flex: 1, gap: space[2], minWidth: 0 },
  trailing: { paddingRight: space[12] },
});
