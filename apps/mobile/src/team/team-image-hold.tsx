import { createContext, useContext, type ReactNode } from "react";
import { Pressable, type StyleProp, type ViewStyle } from "react-native";
import { ImageHold, type ImageActionsSource } from "../images/image-actions.js";

export const TeamImageSources = createContext<((id: string) => ImageActionsSource) | null>(null);

export function TeamImageHold(props: {
  readonly id: string;
  readonly children: ReactNode;
  readonly onPress: () => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const source = useContext(TeamImageSources);
  if (source === null)
    return (
      <Pressable onPress={props.onPress} style={props.style}>
        {props.children}
      </Pressable>
    );
  return (
    <ImageHold source={source(props.id)} onPress={props.onPress} style={props.style}>
      {props.children}
    </ImageHold>
  );
}
