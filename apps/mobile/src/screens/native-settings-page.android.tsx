import { Box, ModalBottomSheet, RNHostView, Row, Text, TextButton } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, padding } from "@expo/ui/jetpack-compose/modifiers";
import { SymbolView, type AndroidSymbol } from "expo-symbols";
import { useState, type ReactNode } from "react";
import { color } from "../theme.js";
import { IntegrationIcon } from "../ui/integration-icon.js";
import type { SFSymbolName } from "../ui/symbol.js";
import type { NativeSettingsPageProps, NativeSettingsRow } from "./native-settings-page.types.js";
import {
  ActionRow,
  Avatar,
  ChoiceRow,
  Footer,
  InputRow,
  LinkRow,
  MenuRow,
  PrimaryButton,
  SectionHeader,
  SettingsHost,
  SettingsList,
  StatusRow,
  ToggleRow,
} from "./settings-form-primitives.android.js";

export function NativeSettingsPage(props: NativeSettingsPageProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const list = (
    <SettingsList>
      {props.search ? <InputRow label="Search plugins" {...props.search} /> : null}
      {props.sections.map((section) => {
        const open = !section.collapsed || expanded.has(section.key);
        return [
          section.title ? (
            <SectionHeader
              key={`${section.key}:title`}
              title={section.title}
              {...(section.collapsed
                ? {
                    expanded: open,
                    onPress: () =>
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(section.key)) next.delete(section.key);
                        else next.add(section.key);
                        return next;
                      }),
                  }
                : {})}
            />
          ) : null,
          ...(open
            ? section.rows.map((row) => <Row_ key={`${section.key}:${row.key}`} row={row} />)
            : []),
          open && section.footer ? (
            <Footer
              key={`${section.key}:footer`}
              text={section.footer.text}
              tone={section.footer.tone}
            />
          ) : null,
        ];
      })}
    </SettingsList>
  );
  if (!props.sheet) return <SettingsHost>{list}</SettingsHost>;
  const sheet = props.sheet;
  return (
    <SettingsHost>
      <ModalBottomSheet onDismissRequest={sheet.onClose} containerColor={color.surfaceElevated}>
        <Row
          verticalAlignment="center"
          horizontalArrangement="spaceBetween"
          modifiers={[fillMaxWidth(), padding(16, 0, 8, 4)]}
        >
          <Text color={color.text} style={{ typography: "titleLarge" }}>
            {sheet.title}
          </Text>
          <TextButton onClick={sheet.onClose}>
            <Text>Close</Text>
          </TextButton>
        </Row>
        {list}
      </ModalBottomSheet>
    </SettingsHost>
  );
}

function Row_({ row }: { readonly row: NativeSettingsRow }): ReactNode {
  switch (row.kind) {
    case "chips":
      return (
        <ChoiceRow
          choices={row.choices}
          onChange={row.onChange}
          title={row.label}
          value={row.value}
        />
      );
    case "text":
      return (
        <LinkRow
          detail={row.detail}
          lead={row.initial === undefined ? null : <Avatar initial={row.initial} />}
          title={row.label}
        />
      );
    case "status":
      return <StatusRow detail={row.detail} label={row.label} steps={row.steps} tone={row.tone} />;
    case "primary":
      return <PrimaryButton disabled={row.disabled} label={row.label} onPress={row.onPress} />;
    case "toggle":
      return (
        <ToggleRow
          detail={row.detail}
          disabled={row.disabled}
          onChange={row.onChange}
          title={row.label}
          value={row.value}
        />
      );
    case "input":
      return (
        <InputRow label={row.label} onChange={row.onChange} secure={row.secure} value={row.value} />
      );
    case "button": {
      const material = row.symbol === undefined ? undefined : materialSymbols[row.symbol];
      const lead = row.mark ? (
        <Box modifiers={[]}>
          <RNHostView matchContents>
            <IntegrationIcon definitionId={row.mark.definitionId} name={row.mark.name} size={28} />
          </RNHostView>
        </Box>
      ) : material !== undefined ? (
        <Box modifiers={[]}>
          <RNHostView matchContents>
            <SymbolView name={{ android: material }} size={24} tintColor={color.muted} />
          </RNHostView>
        </Box>
      ) : null;
      if (row.actions?.length)
        return (
          <MenuRow
            actions={row.actions}
            destructive={row.destructive}
            detail={row.detail}
            disabled={row.disabled}
            lead={lead}
            onPress={row.onPress}
            title={row.label}
          />
        );
      // A bare action reads as one; a row about a thing reads as that thing.
      if (row.detail === undefined && row.opens !== true && lead === null)
        return (
          <ActionRow
            destructive={row.destructive}
            disabled={row.disabled}
            label={row.label}
            onPress={row.onPress}
          />
        );
      return (
        <LinkRow
          destructive={row.destructive}
          detail={row.detail}
          disabled={row.disabled}
          lead={lead}
          onPress={row.onPress}
          title={row.label}
        />
      );
    }
  }
}

const materialSymbols: Partial<Record<SFSymbolName, AndroidSymbol>> = {
  camera: "videocam",
  desktopcomputer: "desktop_mac",
  globe: "language",
  hifispeaker: "speaker",
  laptopcomputer: "laptop_mac",
  lightbulb: "lightbulb",
  macmini: "host",
  powerplug: "power",
  "server.rack": "dns",
  smartphone: "smartphone",
  tv: "tv",
};
