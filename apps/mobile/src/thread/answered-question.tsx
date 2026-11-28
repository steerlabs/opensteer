import { formatClockTime } from "@opensteer/client/host";
import type { AnsweredQuestionRead } from "@opensteer/client/react";
import type { AnsweredQuestion } from "@opensteer/core";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Markdown } from "../markdown/markdown.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { Symbol } from "../ui/symbol.js";
import { MessageFold } from "./message-fold.js";

/** Body lines of what was asked before Show more: a short draft whole. */
const detailLines = 8;

/**
 * What was asked, then the answer: the draft folded as in the card, each
 * question's answer in its own words. A `cut` record has one disclosure for
 * the whole of it, on the draft's fold or, without a draft, its own.
 */
export function AnsweredQuestionView(props: {
  readonly answeredAt: string;
  readonly cut?: boolean;
  readonly onRetry?: () => void;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly question: AnsweredQuestion;
  readonly read?: AnsweredQuestionRead;
  readonly title: string;
}): ReactNode {
  const { question, open, title } = props;
  const read = props.read ?? "whole";
  const dismissed = question.outcome === "dismissed";
  const several = question.answers.length > 1;
  const excerpt = question.truncated === true;
  return (
    <View accessibilityLabel={`Question: ${title}`} style={styles.answered}>
      <View style={styles.head}>
        <Symbol
          name={dismissed ? "stop.circle" : "checkmark.circle"}
          size={13}
          tint={color.green}
        />
        <AppText role="caption" tone="muted">
          {dismissed ? "Dismissed" : "You answered"} · {formatClockTime(props.answeredAt)}
        </AppText>
      </View>
      <AppText role="secondaryMedium">{title}</AppText>
      {question.detail ? (
        <MessageFold
          lines={detailLines}
          mine={false}
          more={props.cut === true}
          onToggle={props.onToggle}
          open={open}
        >
          {question.detailFormat === "plain" ? (
            <AppText role="caption" tone="soft">
              {question.detail}
            </AppText>
          ) : (
            <Markdown excerpt={excerpt} text={question.detail} />
          )}
        </MessageFold>
      ) : null}
      {question.answers.map(({ prompt, answer }, index) => (
        <View key={index} style={styles.answer}>
          {several || prompt.trim() !== title.trim() ? (
            <AppText role="caption" tone="muted">
              {prompt}
            </AppText>
          ) : null}
          {answer.length ? (
            <View style={styles.words}>
              <AppText role="secondary">{answer.join(", ")}</AppText>
            </View>
          ) : null}
        </View>
      ))}
      {props.cut === true && !question.detail ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={props.onToggle}
          style={styles.toggle}
        >
          <AppText role="secondaryMedium" tone="ember">
            {open ? "Show less" : "Show more"}
          </AppText>
        </Pressable>
      ) : null}
      {open && read === "loading" ? (
        <AppText role="caption" tone="muted">
          Loading the whole question…
        </AppText>
      ) : open && read === "unavailable" ? (
        <AppText role="caption" tone="muted">
          The whole question is no longer available.
        </AppText>
      ) : open && read === "failed" ? (
        <Pressable accessibilityRole="button" onPress={props.onRetry}>
          <AppText role="caption" tone="muted">
            Couldn’t load the whole question. Tap to retry.
          </AppText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  answer: { alignItems: "flex-start", gap: space[4] },
  answered: {
    borderLeftColor: color.line,
    borderLeftWidth: 2,
    gap: space[8],
    paddingLeft: space[12],
  },
  head: { alignItems: "center", flexDirection: "row", gap: space[6] },
  toggle: { alignSelf: "flex-start", justifyContent: "center", minHeight: touchTarget },
  words: {
    backgroundColor: color.greenWash,
    borderRadius: radius.md,
    paddingHorizontal: space[12],
    paddingVertical: space[4],
  },
});
