import { voiceCursorPath } from "@opensteer/client/voice";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import Svg, { Line, Path, Rect } from "react-native-svg";
import { Symbol } from "../ui/symbol.js";

/** Voice's one mark, wherever Voice has a name: the pill, the sidebar row, the Thread's header. */
export function VoiceCursor(props: { readonly size: number; readonly tint: string }): ReactNode {
  return (
    <Svg height={props.size} viewBox="0 0 16 18" width={(props.size * 16) / 18}>
      <Path
        d={voiceCursorPath}
        fill={props.tint}
        stroke={props.tint}
        strokeLinejoin="round"
        strokeWidth={1}
      />
    </Svg>
  );
}

/**
 * The pill's mic. iOS has its own; Android has no icon set, and its character
 * fallback reads as a music note on the control a call uses most.
 */
export function PillMic(props: {
  readonly muted: boolean;
  readonly size: number;
  readonly tint: string;
}): ReactNode {
  if (Platform.OS === "ios")
    return (
      <Symbol
        name={props.muted ? "mic.slash" : "mic"}
        size={props.size}
        tint={props.tint}
        weight="medium"
      />
    );
  const stroke = { stroke: props.tint, strokeLinecap: "round", strokeWidth: 1.75 } as const;
  return (
    <Svg fill="none" height={props.size} viewBox="0 0 24 24" width={props.size}>
      <Rect height={13} rx={3} width={6} x={9} y={2} {...stroke} />
      <Path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" {...stroke} />
      {props.muted ? <Line x1={4} x2={20} y1={4} y2={20} {...stroke} /> : null}
    </Svg>
  );
}
