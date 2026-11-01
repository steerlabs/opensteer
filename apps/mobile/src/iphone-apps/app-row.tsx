import type { ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import type { IphoneAppId } from "../platform/iphone-apps.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { color, radius, space, touchTarget } from "../theme.js";
import { AppText, StatusDot } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import type { IphoneLevel, IphoneTone } from "./model.js";

/** Each app's mark, in the colour its own iPhone app wears, so a row is found before it is read. */
const appMarks: Readonly<
  Record<IphoneAppId, { readonly fill: string; readonly symbol: SFSymbolName }>
> = {
  "apple-calendar": { fill: "#ff453a", symbol: "calendar" },
  "apple-contacts": { fill: "#8e8e93", symbol: "person.crop.circle" },
  "apple-reminders": { fill: "#ff9f0a", symbol: "checklist" },
  "iphone-location": { fill: "#0a84ff", symbol: "location.fill" },
  "iphone-photos": { fill: "#bf5af2", symbol: "photo" },
};

/**
 * One of an iPhone's apps: its mark and name, a line saying what limits it or
 * what agents can do with it, and the control at the end — normally a switch.
 * An app with more than one access level shows its level as the line itself,
 * which opens the system menu to choose another.
 */
export function IphoneAppRow(props: {
  readonly app: IphoneAppId;
  readonly children?: ReactNode;
  /** Why the level menu can't be used now, said when it is tapped; null when it can. */
  readonly disabledReason: string | null;
  /** The levels the line chooses between; empty when it is only words. */
  readonly levels: readonly IphoneLevel[];
  readonly line: string;
  readonly name: string;
  readonly onLevel?: (level: IphoneLevel) => void;
  readonly tone: IphoneTone;
  readonly trailing: ReactNode;
}): ReactNode {
  const mark = appMarks[props.app];
  const onLevel = props.onLevel;
  const words = (
    <View style={styles.line}>
      {props.tone === "amber" ? <StatusDot tone="amber" /> : null}
      <AppText
        role="secondary"
        style={styles.lineText}
        tone={onLevel === undefined || props.levels.length === 0 ? "muted" : "ember"}
      >
        {props.line}
      </AppText>
      {onLevel === undefined || props.levels.length === 0 ? null : (
        <Symbol name="chevron.down" size={11} tint={color.ember} weight="semibold" />
      )}
    </View>
  );
  return (
    <View>
      <View style={styles.row}>
        <View style={[styles.mark, { backgroundColor: mark.fill }]}>
          <Symbol name={mark.symbol} size={17} tint="#ffffff" weight="medium" />
        </View>
        {onLevel === undefined || props.levels.length === 0 ? (
          // One element for a screen reader: the app, then what limits it.
          <View accessible accessibilityLabel={`${props.name}, ${props.line}`} style={styles.text}>
            <AppText role="body">{props.name}</AppText>
            {words}
          </View>
        ) : (
          // The name and level together are the menu's trigger, so the target
          // is the row's height rather than one line of small text.
          <NativeMenu
            accessibilityHint="Chooses what agents can do"
            accessibilityLabel={`${props.name}, ${props.line}`}
            disabledReason={props.disabledReason}
            onPresent={noop}
            onSettle={noop}
            options={props.levels.map((level) => ({
              id: level.access,
              label: level.label,
              onPress: () => {
                if (level.action !== "current") onLevel(level);
              },
              selected: level.action === "current",
            }))}
            style={styles.text}
            title={`${props.name} access`}
          >
            <AppText role="body">{props.name}</AppText>
            {words}
          </NativeMenu>
        )}
        {props.trailing}
      </View>
      {props.children}
    </View>
  );
}

function noop(): void {}

const styles = StyleSheet.create({
  line: { alignItems: "center", flexDirection: "row", gap: space[6] },
  lineText: { flexShrink: 1 },
  mark: {
    alignItems: "center",
    borderCurve: "continuous",
    borderRadius: radius.sm,
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: space[12],
    minHeight: touchTarget + space[16],
    paddingHorizontal: space[16],
    paddingVertical: space[10],
  },
  text: { flex: 1, gap: space[2], minWidth: 0 },
});
