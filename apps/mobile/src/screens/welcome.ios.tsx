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
import { color } from "../theme.js";
import { Chevron, ErrorText, Footer } from "./settings-form-primitives.ios.js";
import {
  shareMacLink,
  welcomeCopy,
  welcomePresentation,
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

/** The first run on iOS: a system form, like Settings, with the scan as its one action. */
export function Welcome(props: WelcomeProps): ReactNode {
  const view = welcomePresentation(props);
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
              modifiers={[font({ size: 28, weight: "bold" }), foregroundStyle(color.text), centred]}
            >
              {welcomeCopy.title}
            </Text>
            <Text modifiers={[font({ textStyle: "body" }), secondary, centred]}>
              {welcomeCopy.sentence}
            </Text>
          </VStack>
          <Button
            modifiers={[
              ...bare(12, 0),
              buttonStyle("borderedProminent"),
              buttonBorderShape("capsule"),
              controlSize("large"),
              tint(color.ember),
            ]}
            onPress={props.onScan}
          >
            <Text
              modifiers={[
                font({ textStyle: "headline" }),
                foregroundStyle(color.inkOnEmber),
                frame({ maxWidth: Infinity }),
              ]}
            >
              {welcomeCopy.scan}
            </Text>
          </Button>
        </Section>
        <Section footer={<Footer text={view.footer} />} title={welcomeCopy.otherWays}>
          <ErrorText detail={view.failure} />
          {view.account === null ? null : (
            <Button modifiers={[disabled(view.account.disabled)]} onPress={props.onAccount}>
              <Row busy={props.signingIn} label={view.account.label} />
            </Button>
          )}
          <Button onPress={props.onAddress}>
            <Row busy={false} label={welcomeCopy.address} />
          </Button>
        </Section>
        {view.macLink === null ? null : (
          <Section>
            <Button modifiers={bare(0, 0)} onPress={() => shareMacLink(view.macLink!)}>
              <Text
                modifiers={[
                  font({ textStyle: "footnote" }),
                  foregroundStyle(color.ember),
                  frame({ maxWidth: Infinity }),
                ]}
              >
                {welcomeCopy.mac}
              </Text>
            </Button>
          </Section>
        )}
      </Form>
    </Host>
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
