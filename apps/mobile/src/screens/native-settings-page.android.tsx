import { Box, ModalBottomSheet, RNHostView, Row, Text, TextButton } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, padding } from "@expo/ui/jetpack-compose/modifiers";
import { SymbolView, type AndroidSymbol } from "expo-symbols";
import { useState, type ReactNode } from "react";
import { color } from "../theme.js";
import { RowMarkIcon } from "../ui/integration-icon.js";
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
  PlaceholderRow,
  PrimaryButton,
  SectionHeader,
  SelectRow,
  SettingsHost,
  SettingsList,
  StatusRow,
  ToggleRow,
  UnknownToggleRow,
} from "./settings-form-primitives.android.js";

export function NativeSettingsPage(props: NativeSettingsPageProps): ReactNode {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const action = props.sections
    .filter((section) => !section.collapsed || expanded.has(section.key))
    .flatMap((section) => section.rows)
    .find((row) => row.kind === "primary" && row.pinned);
  const list = (
    <SettingsList footer={action ? <Row_ row={action} /> : null}>
      {props.search ? (
        <InputRow
          label={props.search.prompt ?? "Search plugins"}
          onChange={props.search.onChange}
          value={props.search.value}
        />
      ) : null}
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
            ? section.rows
                .filter((row) => row !== action)
                .map((row) => <Row_ key={`${section.key}:${row.key}`} row={row} />)
            : []),
          open && section.footer ? (
            <Footer
              key={`${section.key}:footer`}
              link={section.footer.link ?? null}
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

/** The sections of a page, for a form that draws its own header above them. */
export function NativeSettingsSections(props: {
  readonly sections: NativeSettingsPageProps["sections"];
}): ReactNode {
  return props.sections.map((section) => [
    section.title ? <SectionHeader key={`${section.key}:title`} title={section.title} /> : null,
    ...section.rows.map((row) => <Row_ key={`${section.key}:${row.key}`} row={row} />),
    section.footer ? (
      <Footer
        key={`${section.key}:footer`}
        link={section.footer.link ?? null}
        text={section.footer.text}
        tone={section.footer.tone}
      />
    ) : null,
  ]);
}

function Row_({ row }: { readonly row: NativeSettingsRow }): ReactNode {
  switch (row.kind) {
    case "chips":
      return (
        <ChoiceRow
          choices={row.choices}
          menu={row.menu}
          onChange={row.onChange}
          title={row.label}
          value={row.value}
        />
      );
    case "choice":
      return (
        <SelectRow
          detail={row.detail}
          disabled={row.disabled}
          multiple={row.multiple}
          onPress={row.onPress}
          selected={row.selected}
          title={row.label}
        />
      );
    case "text":
      return (
        <LinkRow
          {...rowAddress(row.addressIn)}
          detail={row.detail}
          lead={row.initial === undefined ? null : <Avatar initial={row.initial} />}
          title={row.label}
          titleParts={row.labelParts}
        />
      );
    case "status":
      return (
        <StatusRow
          addressIn={row.addressIn}
          detail={row.detail}
          label={row.label}
          steps={row.steps}
          tone={row.tone}
        />
      );
    case "primary":
      return <PrimaryButton disabled={row.disabled} label={row.label} onPress={row.onPress} />;
    case "placeholder":
      return <PlaceholderRow label={row.label} />;
    case "toggle":
      if (row.value === null) return <UnknownToggleRow detail={row.detail} title={row.label} />;
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
            <RowMarkIcon mark={row.mark} size={28} />
          </RNHostView>
        </Box>
      ) : row.lead ? (
        <Box modifiers={[]}>
          <RNHostView matchContents>{row.lead}</RNHostView>
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
            {...rowAddress(row.addressIn)}
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
          {...rowAddress(row.addressIn)}
          destructive={row.destructive}
          detail={row.detail}
          detailTone={row.tone}
          disabled={row.disabled}
          lead={lead}
          onPress={row.onPress}
          title={row.label}
        />
      );
    }
  }
}

/** A row's `addressIn` as the row's lines name them. */
function rowAddress(addressIn: "label" | "detail" | undefined): {
  readonly addressIn?: "title" | "detail";
} {
  return addressIn === undefined ? {} : { addressIn: addressIn === "label" ? "title" : "detail" };
}

const materialSymbols: Partial<Record<SFSymbolName, AndroidSymbol>> = {
  camera: "videocam",
  checklist: "checklist",
  desktopcomputer: "desktop_mac",
  globe: "language",
  hifispeaker: "speaker",
  laptopcomputer: "laptop_mac",
  lightbulb: "lightbulb",
  macmini: "host",
  powerplug: "power",
  "puzzlepiece.extension": "extension",
  "rectangle.on.rectangle": "apps",
  "server.rack": "dns",
  smartphone: "smartphone",
  tv: "tv",
};
