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
import { useState, type ReactNode } from "react";
import { thisPhoneNoun } from "../computers/phone-noun.js";
import { color } from "../theme.js";
import { Chevron, ErrorText, Footer, Lines } from "./settings-form-primitives.ios.js";
import {
  keylessWelcomeCopy,
  shareMacLink,
  welcomeCopy,
  welcomePresentation,
  type WelcomeProps,
} from "./welcome-model.js";
import { addressWords } from "../ui/address-words.js";

const secondary = foregroundStyle({ type: "hierarchical", style: "secondary" });
const centred = multilineTextAlignment("center");
/** A row drawn on the page itself rather than on the section's plate. */
const bare = (top: number, bottom: number) => [
  listRowBackground("clear"),
  listRowSeparator("hidden"),
  listRowInsets({ bottom, leading: 0, top, trailing: 0 }),
];

export function Welcome(props: WelcomeProps): ReactNode {
  const view = welcomePresentation(props);
  const link = view.macLink;
  const keyless = view.mode === "keyless";
  // On the door and on "where", the other ways in wait behind one small link.
  const [otherWays, setOtherWays] = useState(false);
  const cloud = view.cloud;
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
              {view.title}
            </Text>
            <Text modifiers={[font({ textStyle: "body" }), secondary, centred]}>
              {view.sentence(thisPhoneNoun)}
            </Text>
          </VStack>
          {/* The Opensteer account finds a Home on a Mac or a Cloud Computer, so it leads. */}
          {view.account === null ? null : (
            <Wide
              disabled={view.account.disabled || props.signingIn}
              label={view.account.label}
              onPress={props.onAccount}
              prominent
            />
          )}
          {keyless && link !== null ? (
            <Wide onPress={() => shareMacLink(link)} prominent label={welcomeCopy.mac} />
          ) : null}
          {keyless ? (
            <Wide
              onPress={props.onScan}
              prominent={link === null}
              label={keylessWelcomeCopy.scan}
            />
          ) : null}
        </Section>
        {view.mode === "where" ? (
          <>
            <Section title={welcomeCopy.onMac}>
              {view.signedInAs === null ? null : (
                <Lines detail="Opensteer account" title={addressWords(view.signedInAs)} />
              )}
              <Text modifiers={[font({ textStyle: "body" }), secondary]}>
                {welcomeCopy.onMacDetail}
              </Text>
              {link === null ? null : (
                <Button onPress={() => shareMacLink(link)}>
                  <Row busy={false} label={welcomeCopy.mac} />
                </Button>
              )}
            </Section>
            {cloud === null ? null : (
              <Section title={welcomeCopy.onCloud}>
                <Text modifiers={[font({ textStyle: "body" }), secondary]}>
                  {cloud.price === null ? cloud.detail : `${cloud.price}. ${cloud.detail}`}
                </Text>
                {cloud.address === null ? null : (
                  <Lines detail={addressWords(cloud.address)} title={welcomeCopy.cloudAddress} />
                )}
                {cloud.address === null ? null : (
                  <Button onPress={() => props.onCopyCloudAddress?.(cloud.address!)}>
                    <Row
                      busy={false}
                      label={props.cloudCopied ? welcomeCopy.copied : welcomeCopy.copy}
                    />
                  </Button>
                )}
              </Section>
            )}
          </>
        ) : null}
        {keyless || otherWays ? (
          <Section
            footer={view.footer === null ? undefined : <Footer text={view.footer} />}
            title={welcomeCopy.otherWays}
          >
            <ErrorText detail={view.mode === "door" ? null : view.failure} />
            {keyless ? null : (
              <Button onPress={props.onScan}>
                <Row busy={false} detail={welcomeCopy.scanDetail} label={welcomeCopy.scan} />
              </Button>
            )}
            <Button onPress={props.onAddress}>
              <Row
                busy={false}
                detail={keyless ? undefined : welcomeCopy.addressDetail}
                label={keyless ? keylessWelcomeCopy.address : welcomeCopy.address}
              />
            </Button>
          </Section>
        ) : (
          <Section footer={view.footer === null ? undefined : <Footer text={view.footer} />}>
            <ErrorText detail={view.failure} />
            <Button modifiers={[...bare(0, 0)]} onPress={() => setOtherWays(true)}>
              <Text
                modifiers={[
                  font({ textStyle: "subheadline" }),
                  foregroundStyle(color.ember),
                  frame({ maxWidth: Infinity }),
                ]}
              >
                {welcomeCopy.otherWays}
              </Text>
            </Button>
          </Section>
        )}
      </Form>
    </Host>
  );
}

function Wide(props: {
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly prominent: boolean;
}): ReactNode {
  return (
    <Button
      modifiers={[
        disabled(props.disabled === true),
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

function Row(props: {
  readonly busy: boolean;
  readonly detail?: string | undefined;
  readonly label: string;
}): ReactNode {
  return (
    <HStack alignment="center" modifiers={[contentShape(shapes.rectangle())]} spacing={12}>
      {props.detail === undefined ? (
        <Text modifiers={[font({ textStyle: "body" }), foregroundStyle(color.text)]}>
          {props.label}
        </Text>
      ) : (
        <Lines detail={props.detail} title={props.label} />
      )}
      <Spacer />
      {props.busy ? <ProgressView /> : <Chevron />}
    </HStack>
  );
}
