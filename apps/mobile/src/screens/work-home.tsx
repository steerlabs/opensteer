import {
  cloudWords,
  orgWords,
  workAuditExcluded,
  workAuditRecordKinds,
  workHomeBadges,
  type WorkHomeCard,
} from "@opensteer/client/computers";
import { useCloudComputer } from "@opensteer/client/react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useEffect, useMemo, type ReactNode } from "react";
import { useMobileClient } from "../ui/mobile-client-context.js";
import { NativeSettingsPage } from "./native-settings-page.js";
import type { NativeSettingsSection } from "./native-settings-page.types.js";

/** The person's work Homes, from the one Cloud Computer read the app already makes. */
export function useWorkHomes(): readonly WorkHomeCard[] {
  return useCloudComputer(useMobileClient().cloudComputers ?? null).work;
}

/** Each listed work Home's "Work · {organization}" badge, by Home. */
export function useWorkBadges(): ReadonlyMap<string, string> {
  const work = useWorkHomes();
  return useMemo(
    () => new Map([...workHomeBadges(work)].map(([id, card]) => [id, card.badge])),
    [work],
  );
}

/**
 * Each work Home on the Cloud Computer screen: whose it is, where it stands, what its
 * organization decides, and no billing or power, which are the organization's.
 */
export function workHomeSections(
  cards: readonly WorkHomeCard[],
  handlers: {
    readonly listed: (deploymentId: string | null) => boolean;
    readonly onOpen: (deploymentId: string) => void;
    readonly onSee: (card: WorkHomeCard) => void;
  },
): readonly NativeSettingsSection[] {
  return cards.flatMap((card): NativeSettingsSection[] => {
    const listed = card.address !== null && handlers.listed(card.deploymentId);
    return [
      {
        key: `work-${card.assignmentId}`,
        title: card.title,
        rows: [
          {
            key: "status",
            kind: "status",
            tone: card.status.tone,
            label: card.status.label,
            ...(card.address ? { detail: card.address } : {}),
            ...(card.steps ? { steps: card.steps } : {}),
          },
          ...(card.address && card.deploymentId
            ? [
                {
                  key: "open",
                  kind: "button" as const,
                  label: cloudWords("cloud.ready.open"),
                  disabled: !listed,
                  onPress: () => handlers.onOpen(card.deploymentId!),
                },
              ]
            : []),
          ...(card.region
            ? [
                {
                  key: "region",
                  kind: "text" as const,
                  label: cloudWords("cloud.region"),
                  detail: card.region,
                },
              ]
            : []),
          ...(card.browserAddress
            ? [
                {
                  key: "browser-address",
                  kind: "text" as const,
                  label: cloudWords("cloud.ip.address"),
                  detail: card.browserAddress,
                },
              ]
            : []),
        ],
        footer: { text: [card.status.reason, card.managed].filter(Boolean).join(" ") },
      },
      {
        key: `work-policy-${card.assignmentId}`,
        title: card.policyTitle,
        rows: [
          ...card.policy.map((line) => ({
            key: line.title,
            kind: "text" as const,
            label: `${line.title}: ${line.value}`,
            detail: line.detail,
          })),
          {
            key: "see",
            kind: "button",
            label: card.seeTitle,
            opens: true,
            onPress: () => handlers.onSee(card),
          },
        ],
      },
    ];
  });
}

/** A work Home's own page: its badge and the way to what its organization can see. */
export function homeWorkSection(
  card: WorkHomeCard,
  onSee: (card: WorkHomeCard) => void,
): NativeSettingsSection {
  return {
    key: "work",
    title: "",
    rows: [
      {
        key: "see",
        kind: "button",
        label: card.badge,
        detail: card.seeTitle,
        opens: true,
        onPress: () => onSee(card),
      },
    ],
    footer: { text: card.managed },
  };
}

/** What the organization can see of a work Home, from the record schema it sends. */
export function workHomeSeeSections(card: WorkHomeCard): readonly NativeSettingsSection[] {
  const organization = card.organizationName;
  return [
    {
      key: "lead",
      title: "",
      rows: [],
      footer: { text: orgWords("org.work.see.lead", { organization }) },
    },
    {
      key: "sees",
      title: orgWords("org.work.see.sees", { organization }),
      rows: [
        { key: "status", kind: "text", label: orgWords("org.work.see.status") },
        { key: "policy", kind: "text", label: orgWords("org.work.see.policy") },
      ],
    },
    {
      key: "records",
      title: orgWords("org.work.see.records"),
      rows: workAuditRecordKinds.map(({ kind, words }) => ({
        key: kind,
        kind: "text",
        label: words,
      })),
    },
    {
      key: "never",
      title: orgWords("org.work.see.never", { organization }),
      rows: [
        ...workAuditExcluded.map((item) => ({ key: item, kind: "text" as const, label: item })),
        { key: "personal", kind: "text", label: orgWords("org.work.see.personal") },
      ],
    },
  ];
}

type Props = StaticScreenProps<{ readonly assignmentId: string }>;

export function WorkHomeSeeScreen({ route }: Props): ReactNode {
  const work = useWorkHomes();
  const navigation = useNavigation();
  const card = work.find((entry) => entry.assignmentId === route.params.assignmentId) ?? null;
  const title = card?.seeTitle ?? null;
  useEffect(() => {
    if (title) navigation.setOptions({ title });
  }, [navigation, title]);
  return (
    <NativeSettingsPage
      sections={
        card
          ? workHomeSeeSections(card)
          : [
              {
                key: "loading",
                title: "",
                rows: [{ key: "loading", kind: "placeholder", label: cloudWords("cloud.loading") }],
              },
            ]
      }
    />
  );
}
