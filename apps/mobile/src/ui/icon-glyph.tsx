import type { IconName } from "@opensteer/core";
import { iconArt } from "@opensteer/client/host";
import type { ReactNode } from "react";
import Svg, { Circle, Ellipse, Line, Path, Polyline, Rect } from "react-native-svg";

/**
 * The same 24×24 artwork the web draws, so an agent's icon reads identically
 * on every platform rather than through SF Symbols on one and a character on
 * the other.
 */
export function IconGlyph(props: {
  readonly color: string;
  readonly icon: IconName;
  readonly size: number;
  readonly strokeWidth?: number;
}): ReactNode {
  return (
    <Svg
      // `currentColor` in the artwork (its few filled dots) resolves to this.
      color={props.color}
      fill="none"
      height={props.size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={props.strokeWidth ?? 2}
      viewBox="0 0 24 24"
      width={props.size}
    >
      {iconArt[props.icon].elements.map(([tag, attributes], index) => {
        switch (tag) {
          case "circle":
            return <Circle key={index} {...attributes} />;
          case "ellipse":
            return <Ellipse key={index} {...attributes} />;
          case "line":
            return <Line key={index} {...attributes} />;
          case "path":
            return <Path key={index} {...attributes} />;
          case "polyline":
            return <Polyline key={index} {...attributes} />;
          case "rect":
            return <Rect key={index} {...attributes} />;
        }
      })}
    </Svg>
  );
}
