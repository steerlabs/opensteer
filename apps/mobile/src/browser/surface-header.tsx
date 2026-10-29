import { useNavigation } from "@react-navigation/native";
import type { NativeStackHeaderItemMenuAction } from "@react-navigation/native-stack";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { color, headerFontScaleLimit, space, touchTarget } from "../theme.js";
import { NativeMenu } from "../thread/composer-menu.js";
import { AppText } from "../ui/primitives.js";
import { Symbol, type SFSymbolName } from "../ui/symbol.js";
import { ActingDot, agentWorkingLabel } from "./acting-dot.js";

/** An SF Symbol a native bar menu can draw. */
type MenuSymbol = Extract<
  NonNullable<NativeStackHeaderItemMenuAction["icon"]>,
  { readonly type: "sfSymbol" }
>["name"];

/** One choice in a focused page's or app's ⋯ menu. */
export interface SurfaceMenuItem {
  readonly destructive?: boolean;
  readonly disabled?: boolean;
  /** What the choice does, where the menu can say more than its words (iOS). */
  readonly hint?: string;
  /** The SF Symbol iOS draws beside it; Android's menu is words alone. */
  readonly icon?: MenuSymbol;
  readonly id: string;
  readonly label: string;
  readonly onPress: () => void;
}

/**
 * The compact bar over a focused page or Mac app: the native Back, the page's
 * title with its site (or the app with its Mac) under it, and ⋯.
 *
 * The bar is rebuilt only when what it says changes. The menu's handlers are
 * read when a choice is made, so a page that re-renders on every picture does
 * not rebuild a native bar on every picture.
 */
export function useSurfaceHeader(props: {
  readonly acting: boolean;
  readonly glyph: Extract<SFSymbolName, "globe" | "laptopcomputer" | "smartphone">;
  readonly menu: readonly SurfaceMenuItem[];
  /** Given, the title is a control: a page's opens its address. */
  readonly onTitlePress?: (() => void) | undefined;
  readonly secondary: string | null;
  readonly title: string;
  readonly titleHint?: string;
}): void {
  const navigation = useNavigation();
  const menu = useRef(props.menu);
  menu.current = props.menu;
  const titlePress = useRef(props.onTitlePress);
  titlePress.current = props.onTitlePress;
  const pressable = props.onTitlePress !== undefined;
  // What the bar draws, as one value: an unchanged bar is not set again, and
  // the menu it draws is the one this render read.
  const shape = JSON.stringify(
    props.menu.map(({ destructive, disabled, hint, icon, id, label }) => [
      id,
      label,
      hint ?? null,
      icon ?? null,
      destructive === true,
      disabled === true,
    ]),
  );
  const { acting, glyph, secondary, title, titleHint } = props;

  useLayoutEffect(() => {
    const items = menu.current;
    const choose = (id: string) => menu.current.find((item) => item.id === id)?.onPress();
    navigation.setOptions({
      headerTitle: () => (
        <SurfaceTitle
          acting={acting}
          glyph={glyph}
          hint={titleHint}
          onPress={pressable ? () => titlePress.current?.() : undefined}
          secondary={secondary}
          title={title}
        />
      ),
      headerRight: () =>
        items.length === 0 ? null : (
          <NativeMenu
            accessibilityLabel="More"
            accessibilityHint="Shows actions for this page"
            onPresent={noop}
            onSettle={noop}
            options={items.map(({ destructive, disabled, id, label }) => ({
              ...(destructive === true ? { destructive } : {}),
              ...(disabled === true ? { disabled } : {}),
              id,
              label,
              onPress: () => choose(id),
            }))}
            style={styles.more}
          >
            <Symbol name="ellipsis" tint={color.ember} />
          </NativeMenu>
        ),
      title,
      unstable_headerRightItems: () =>
        items.length === 0
          ? []
          : [
              {
                accessibilityLabel: "More",
                icon: { name: "ellipsis", type: "sfSymbol" },
                label: "More",
                menu: {
                  items: items.map(
                    ({
                      destructive,
                      disabled,
                      hint,
                      icon,
                      id,
                      label,
                    }): NativeStackHeaderItemMenuAction => ({
                      ...(destructive === true ? { destructive } : {}),
                      ...(disabled === true ? { disabled } : {}),
                      ...(hint === undefined ? {} : { discoverabilityLabel: hint }),
                      ...(icon === undefined
                        ? {}
                        : { icon: { name: icon, type: "sfSymbol" as const } }),
                      label,
                      onPress: () => choose(id),
                      type: "action",
                    }),
                  ),
                },
                type: "menu",
              },
            ],
    });
    // `shape` stands for the menu: the items are read from this render's ref.
  }, [acting, glyph, navigation, pressable, secondary, shape, title, titleHint]);
}

function noop(): void {}

/**
 * A page's title over its site, or an app over its Mac. The green dot says an
 * agent is acting in it now, and nothing else does.
 */
function SurfaceTitle(props: {
  readonly acting: boolean;
  readonly glyph: Extract<SFSymbolName, "globe" | "laptopcomputer" | "smartphone">;
  readonly hint: string | undefined;
  readonly onPress: (() => void) | undefined;
  readonly secondary: string | null;
  readonly title: string;
}): ReactNode {
  const words = (
    <>
      <View style={styles.titleRow}>
        {props.acting ? <ActingDot grouped /> : null}
        {props.glyph === "smartphone" ? (
          <Symbol name="smartphone" size={13} tint={color.textSoft} />
        ) : null}
        <AppText
          maxFontSizeMultiplier={headerFontScaleLimit}
          numberOfLines={1}
          role="secondaryMedium"
          style={styles.shrink}
        >
          {props.title}
        </AppText>
      </View>
      {props.secondary === null ? null : (
        <View style={styles.titleRow}>
          {props.glyph === "laptopcomputer" ? (
            <Symbol name="laptopcomputer" size={11} tint={color.muted} />
          ) : null}
          <AppText
            maxFontSizeMultiplier={headerFontScaleLimit}
            numberOfLines={1}
            role="caption"
            style={styles.shrink}
            tone="muted"
          >
            {props.secondary}
          </AppText>
        </View>
      )}
    </>
  );
  const label = [
    props.title,
    props.secondary,
    props.acting ? agentWorkingLabel.toLowerCase() : null,
  ]
    .filter((part): part is string => part !== null)
    .join(", ");
  return props.onPress === undefined ? (
    <View accessibilityLabel={label} accessible style={styles.title}>
      {words}
    </View>
  ) : (
    <Pressable
      accessibilityHint={props.hint}
      accessibilityLabel={label}
      accessibilityRole="button"
      hitSlop={space[6]}
      onPress={props.onPress}
      style={({ pressed }) => [styles.title, pressed && styles.pressed]}
    >
      {words}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  more: {
    alignItems: "center",
    justifyContent: "center",
    minHeight: touchTarget,
    minWidth: touchTarget,
  },
  pressed: { opacity: 0.6 },
  shrink: { flexShrink: 1 },
  // Wide enough for a real page title, narrow enough never to reach the bar's
  // own controls: the native title slot is centred between them.
  title: { alignItems: "center", justifyContent: "center", minHeight: touchTarget, maxWidth: 240 },
  titleRow: { alignItems: "center", flexDirection: "row", gap: space[6], maxWidth: "100%" },
});
