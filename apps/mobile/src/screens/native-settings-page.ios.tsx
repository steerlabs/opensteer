import {
  BottomSheet,
  Button,
  ContextMenu,
  SwipeActions,
  Picker,
  DisclosureGroup,
  Host,
  HStack,
  RNHostView,
  Section,
  SecureField,
  Text,
  TextField,
  Toggle,
  useNativeState,
  List,
  NavigationStack,
  Toolbar,
  ToolbarItem,
} from "@expo/ui/swift-ui";
import {
  disabled,
  frame,
  searchable,
  navigationTitle,
  tag,
  pickerStyle,
} from "@expo/ui/swift-ui/modifiers";
import { useNavigation } from "@react-navigation/native";
import { useEffect } from "react";
import { IntegrationIcon } from "../ui/integration-icon.js";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";
export function NativeSettingsPage(props: NativeSettingsPageProps) {
  const query = useNativeState("");
  const navigation = useNavigation();
  const content = (
    <List
      modifiers={
        props.search
          ? [searchable(query, { prompt: "Search plugins", onChange: props.search.onChange })]
          : []
      }
    >
      {props.sections.map((section) => (
        <Section key={section.key} title={section.collapsed ? "" : section.title}>
          {section.collapsed ? (
            <DisclosureGroup label={section.title}>
              {section.rows.map((row) => (
                <Row key={row.key} row={row} />
              ))}
            </DisclosureGroup>
          ) : (
            section.rows.map((row) => <Row key={row.key} row={row} />)
          )}
        </Section>
      ))}
    </List>
  );
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      {props.sheet ? (
        <BottomSheet
          isPresented
          onIsPresentedChange={(open) => {
            if (!open) props.sheet?.onClose();
          }}
        >
          <NavigationStack>
            <Toolbar modifiers={[navigationTitle(props.sheet.title)]}>
              {content}
              <Toolbar.Content>
                <ToolbarItem placement="topBarTrailing">
                  <Button label="Close" onPress={props.sheet.onClose} />
                </ToolbarItem>
              </Toolbar.Content>
            </Toolbar>
          </NavigationStack>
        </BottomSheet>
      ) : props.search ? (
        <NavigationStack>
          <Toolbar modifiers={[navigationTitle("Plugins")]}>
            {content}
            <Toolbar.Content>
              <ToolbarItem placement="topBarLeading">
                <Button label="Settings" onPress={() => navigation.goBack()} />
              </ToolbarItem>
            </Toolbar.Content>
          </Toolbar>
        </NavigationStack>
      ) : (
        content
      )}
    </Host>
  );
}
function Row({ row }: { readonly row: NativeSettingsRow }) {
  if (row.kind === "chips")
    return (
      <Picker
        label={row.label}
        selection={row.value}
        onSelectionChange={row.onChange}
        // A few choices sit side by side; more than fit a row open as a menu.
        modifiers={[pickerStyle(row.choices.length > 3 ? "menu" : "segmented")]}
      >
        {row.choices.map((choice) => (
          <Text key={choice.value} modifiers={[tag(choice.value)]}>
            {choice.label}
          </Text>
        ))}
      </Picker>
    );
  if (row.kind === "text") return <Text>{row.label}</Text>;
  if (row.kind === "button") {
    const plain = (
      <Button
        label={row.label}
        role={row.destructive ? "destructive" : "default"}
        modifiers={[disabled(row.disabled ?? false), frame({ minHeight: 44 })]}
        onPress={row.onPress}
      />
    );
    const button = row.mark ? (
      <HStack spacing={12}>
        <RNHostView matchContents>
          <IntegrationIcon definitionId={row.mark.definitionId} name={row.mark.name} size={28} />
        </RNHostView>
        {plain}
      </HStack>
    ) : (
      plain
    );
    if (!row.actions?.length) return button;
    const actions = row.actions.map((action) => (
      <Button
        key={action.label}
        label={action.label}
        role={action.destructive ? "destructive" : "default"}
        modifiers={[disabled(row.disabled ?? false)]}
        onPress={action.onPress}
      />
    ));
    return (
      <SwipeActions>
        <ContextMenu>
          <ContextMenu.Trigger>{button}</ContextMenu.Trigger>
          <ContextMenu.Items>{actions}</ContextMenu.Items>
        </ContextMenu>
        <SwipeActions.Actions allowsFullSwipe={false}>{actions}</SwipeActions.Actions>
      </SwipeActions>
    );
  }
  if (row.kind === "toggle")
    return (
      <Toggle
        label={row.label}
        isOn={row.value}
        modifiers={[disabled(row.disabled ?? false)]}
        onIsOnChange={row.onChange}
      />
    );
  return <Input row={row} />;
}

function Input({ row }: { readonly row: Extract<NativeSettingsRow, { kind: "input" }> }) {
  const text = useNativeState(row.value);
  useEffect(() => {
    text.set(row.value);
  }, [text, row.value]);
  return row.secure ? (
    <SecureField text={text} placeholder={row.label} onTextChange={row.onChange} />
  ) : (
    <TextField text={text} placeholder={row.label} onTextChange={row.onChange} />
  );
}
