import { requireNativeView } from "expo";
import type { ComponentType, ReactNode } from "react";
import type { NativeSyntheticEvent, StyleProp, ViewStyle } from "react-native";

export interface ContextMenuAction {
  readonly group: number;
  readonly id: string;
  /** An SF Symbol's name. */
  readonly systemImage: string;
  readonly title: string;
}

interface ContextMenuProps {
  readonly actions: readonly ContextMenuAction[];
  readonly children: ReactNode;
  readonly onAction: (event: NativeSyntheticEvent<{ readonly id: string }>) => void;
  readonly previewRadius: number;
  readonly style?: StyleProp<ViewStyle>;
}

export const ContextMenu: ComponentType<ContextMenuProps> =
  requireNativeView<ContextMenuProps>("OpensteerContextMenu");
