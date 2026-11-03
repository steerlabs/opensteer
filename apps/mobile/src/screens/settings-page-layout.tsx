import { ScrollView } from "react-native";
import type { ReactNode } from "react";
import { Screen, useReadingColumn, useListContentInsets } from "../ui/screen.js";
export function SettingsPageLayout({ children }: { readonly children: ReactNode }) {
  return (
    <Screen edgeToEdge>
      <ScrollView
        contentContainerStyle={[
          { gap: 24, padding: 16 },
          useReadingColumn(),
          useListContentInsets(32),
        ]}
      >
        {children}
      </ScrollView>
    </Screen>
  );
}
