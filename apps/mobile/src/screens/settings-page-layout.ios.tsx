import { Host, Form } from "@expo/ui/swift-ui";
import { listStyle } from "@expo/ui/swift-ui/modifiers";
import type { ReactNode } from "react";
export function SettingsPageLayout({ children }: { readonly children: ReactNode }) {
  return (
    <Host style={{ flex: 1 }} useViewportSizeMeasurement>
      <Form modifiers={[listStyle("insetGrouped")]}>{children}</Form>
    </Host>
  );
}
