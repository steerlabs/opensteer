import {
  Button,
  Form,
  HStack,
  Host,
  Image,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import {
  accessibilityHidden,
  buttonBorderShape,
  buttonStyle,
  contentShape,
  controlSize,
  disabled,
  font,
  foregroundStyle,
  frame,
  listRowBackground,
  listRowInsets,
  listRowSeparator,
  listStyle,
  multilineTextAlignment,
  shapes,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { color } from "../theme.js";
import { Chevron, ErrorText, Footer, Lines } from "./settings-form-primitives.ios.js";
import {
  shareMacLink,
  welcomeCopy,
  welcomePresentation,
  welcomeSentence,
  type WelcomeProps,
} from "./welcome-model.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const centred = multilineTextAlignment("center");
/** A row drawn on the page itself rather than on the section's plate. */
const bare = (top: number, bottom: number) => [
  listRowBackground("clear"),
  listRowSeparator("hidden"),
  listRowInsets({ bottom, leading: 0, top, trailing: 0 }),
];

/**
 * Before any Opensteer exists: a system form, like Settings. The Mac link is
 * the way forward; a code on a Mac that already has Opensteer is the other.
 */
export function Welcome(props: WelcomeProps): ReactNode {
  const view = welcomePresentation(props);
  const link = view.macLink;
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <Form modifiers={[listStyle("insetGrouped")]}>
        <Section>
          <VStack modifiers={[...bare(0, 12), frame({ maxWidth: Infinity })]} spacing={10}>
            <Image
              color={color.ember}
              modifiers={[accessibilityHidden(true)]}
              size={40}
              systemName="laptopcomputer.and.iphone"
            />
            <Text
              modifiers={[
                font({ textStyle: "title", weight: "bold" }),
                foregroundStyle(color.text),
                centred,
              ]}
            >
              {welcomeCopy.title}
            </Text>
            <Text modifiers={[font({ textStyle: "body" }), secondary, centred]}>
              {welcomeSentence(thisPhoneNoun)}
            </Text>
          </VStack>
          {link === null ? null : (
            <Wide onPress={() => shareMacLink(link)} prominent label={welcomeCopy.mac} />
          )}
          <Wide onPress={props.onScan} prominent={link === null} label={welcomeCopy.scan} />
        </Section>
        <Section footer={<Footer text={view.footer} />} title={welcomeCopy.otherWays}>
          <ErrorText detail={view.failure} />
          {view.signedInAs === null ? null : (
            <Lines detail="Opensteer Account" title={view.signedInAs} />
          )}
          {view.account === null ? null : (
            <Button modifiers={[disabled(view.account.disabled)]} onPress={props.onAccount}>
              <Row busy={props.signingIn} label={view.account.label} />
            </Button>
          )}
          <Button onPress={props.onAddress}>
            <Row busy={false} label={welcomeCopy.address} />
          </Button>
        </Section>
      </Form>
    </Host>
  );
}

function Wide(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly prominent: boolean;
}): ReactNode {
  return (
    <Button
      modifiers={[
        ...bare(12, 0),
        buttonStyle(props.prominent ? "borderedProminent" : "bordered"),
        buttonBorderShape("capsule"),
        controlSize("large"),
        tint(color.ember),
      ]}
      onPress={props.onPress}
    >
      <Text
        modifiers={[
          font({ textStyle: "headline" }),
          foregroundStyle(props.prominent ? color.inkOnEmber : color.ember),
          frame({ maxWidth: Infinity }),
        ]}
      >
        {props.label}
      </Text>
    </Button>
  );
}

function Row(props: { readonly busy: boolean; readonly label: string }): ReactNode {
  return (
    <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
      <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
        {props.label}
      </Text>
      <Spacer />
      {props.busy ? <ProgressView /> : <Chevron />}
    </HStack>
  );
}
