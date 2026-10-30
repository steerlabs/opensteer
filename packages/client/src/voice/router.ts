import type { HostSnapshot } from "../host/client.js";
import { placeList } from "../host/places.js";
import { taskList } from "../host/task-list.js";
import type { VoiceTarget } from "./contract.js";

export interface VoiceNamedTarget {
  readonly title: string;
  readonly target: VoiceTarget;
}

const ignored = new Set(["the", "my", "a", "an", "task", "tab", "window", "page", "phone"]);
function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}
function tokens(text: string): string[] {
  return normalized(text)
    .split(" ")
    .filter((token) => token && !ignored.has(token));
}

/** Only an entire, unambiguous navigation request changes the screen. */
export function routeUtterance(
  text: string,
  targets: readonly VoiceNamedTarget[],
): VoiceTarget | null {
  const utterance = normalized(text);
  if (utterance === "go back") return { kind: "back" };
  const match = /^(?:show me|go to|switch to|take me to|bring up|pull up|back to) (.+)$/u.exec(
    utterance,
  );
  if (!match) return null;
  const wanted = tokens(match[1]!);
  if (!wanted.length) return null;
  if (wanted.length === 1 && wanted[0] === "chat") return { kind: "chat" };
  const matches = targets.filter(({ title }) => {
    const titleTokens = new Set(tokens(title));
    return wanted.every((token) => titleTokens.has(token));
  });
  return matches.length === 1 ? matches[0]!.target : null;
}

export function voiceTargets(snapshot: HostSnapshot): readonly VoiceNamedTarget[] {
  const tasks = taskList(snapshot);
  return [
    { title: "Chat", target: { kind: "chat" } },
    ...[...tasks.working, ...tasks.ready, ...tasks.done].map((task): VoiceNamedTarget => ({
      title: task.title,
      target: { kind: "thread", threadId: task.threadId },
    })),
    ...placeList(snapshot).map((place): VoiceNamedTarget => ({
      title: place.title,
      target: { kind: "place", destination: place.destination },
    })),
  ];
}
