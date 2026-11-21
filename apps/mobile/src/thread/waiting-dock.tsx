import { waitingDraftSave } from "@opensteer/client/host";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { controlFontScaleLimit, space } from "../theme.js";
import { AppText } from "../ui/primitives.js";
import { AnswerPill } from "./answer-pill.js";
import { ComposerBar, composerLaneHeight } from "./composer-bar.js";
import type { WaitingEditController } from "./waiting-edit.js";

/**
 * Stands where the composer was while a waiting message is open in place, and
 * rides the keyboard as the composer does, so Save is in reach whether or not
 * the keyboard is up. Words that can't be saved
 * where they are, because the message left or changed under them, go on as a
 * new message instead, or are discarded.
 */
export function WaitingEditBar(props: {
  readonly canRespond: boolean;
  readonly editing: WaitingEditController;
  /** The words, and what was attached, on their way into a new message. */
  readonly onSendAsNew: Parameters<WaitingEditController["moveToDraft"]>[0];
}): ReactNode {
  const { editing } = props;
  const edit = editing.edit;
  if (edit === null) return null;
  const { draft } = edit;
  const saving = edit.phase === "saving";
  const stuck = edit.gone || draft.conflict !== null || edit.phase === "refused";
  const ready =
    props.canRespond && edit.phase === "open" && !edit.gone && waitingDraftSave(draft) !== null;
  const cancel = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: saving }}
      disabled={saving}
      hitSlop={{ bottom: 2, left: 2, top: 2 }}
      onPress={editing.cancel}
      style={styles.cancel}
    >
      <AppText maxFontSizeMultiplier={controlFontScaleLimit} role="secondaryMedium" tone="soft">
        {stuck ? "Discard" : "Cancel"}
      </AppText>
    </Pressable>
  );
  const action = stuck ? (
    !draft.dirty ? null : (
      <AnswerPill
        busy={saving}
        disabled={saving}
        label="Send as new message…"
        onPress={() => void editing.moveToDraft(props.onSendAsNew)}
        tone="primary"
      />
    )
  ) : (
    <AnswerPill
      busy={saving}
      disabled={!ready}
      label="Save"
      onPress={() => void editing.save()}
      tone="primary"
    />
  );
  return (
    <ComposerBar
      action={<View style={styles.trailing}>{action}</View>}
      field={<View style={styles.lane} />}
      leading={cancel}
      shape="capsule"
    />
  );
}

const styles = StyleSheet.create({
  // The text button stands where the `+` does, its touch the bar's full height.
  cancel: {
    justifyContent: "center",
    minHeight: composerLaneHeight,
    paddingHorizontal: space[12],
  },
  lane: { minHeight: composerLaneHeight },
  trailing: { paddingRight: space[2] },
});
