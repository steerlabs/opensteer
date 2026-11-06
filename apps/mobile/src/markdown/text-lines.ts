import { createContext } from "react";
import type { TextLayoutEvent } from "react-native";

/** Reports each paragraph's lines to the bubble around them, which sizes itself by the longest. */
export const TextLines = createContext<((event: TextLayoutEvent) => void) | null>(null);
