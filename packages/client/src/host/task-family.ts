import type { AssignmentSummary } from "@opensteer/core";
import {
  assignmentMark,
  assignmentPresentation,
  assignmentTitle,
  type AssignmentReader,
  type AssignmentTone,
} from "./assignment-presentation.js";
import type { HostSnapshot, ThreadAutomation } from "./client.js";
import type { TaskMark } from "./task-marks.js";
import { requestWaitingOnAssignment } from "./waiting-requests.js";

/**
 * A conversation's family: the tasks it handed out and the automations
 * anchored to it. The way back to the conversation it works for is
 * `threadRequester`; this is the way down. Web and mobile both read it, so a
 * task's children never read differently on two screens.
 *
 * Only direct children: each child has its own family, one level at a time.
 * A child is its worker Thread, however many times this conversation handed
 * it work; its newest Assignment says how it is doing.
 */

export interface FamilyTask {
  /** The worker Thread, which is what a row opens. */
  readonly threadId: string;
  readonly assignmentId: string;
  readonly title: string;
  readonly mark: TaskMark;
  /** The Assignment's own word, as its card in the transcript says it. */
  readonly word: string;
  readonly tone: AssignmentTone;
  readonly moving: boolean;
  /** A question this reader answers holds it up, here or inside it. */
  readonly needsYou: boolean;
  /** What the word cannot say: the question, the step, what blocks it, or a result that went nowhere. */
  readonly detail: string | null;
  /** When it settled; null while it is under way. */
  readonly finishedAt: string | null;
}

export interface TaskFamily {
  /** Under way, in the order they were handed out, so a row keeps its place as its state changes. */
  readonly running: readonly FamilyTask[];
  /** Active first, soonest to fire first; then paused ones. */
  readonly automations: readonly ThreadAutomation[];
  /** Settled, most recently finished first. */
  readonly earlier: readonly FamilyTask[];
}

/** What a family is drawn from, and nothing else. */
export type FamilyReader = AssignmentReader &
  Pick<HostSnapshot, "assignments" | "threadAutomations">;

const noAutomations: readonly ThreadAutomation[] = [];

export function taskFamily(reader: FamilyReader, threadId: string): TaskFamily {
  const { open, settled } = children(reader.assignments, threadId);
  return {
    running: open.map((assignment) => familyTask(assignment, reader)),
    automations: arrangedAutomations(reader.threadAutomations[threadId] ?? noAutomations),
    earlier: settled.map((assignment) => familyTask(assignment, reader)),
  };
}

/**
 * The family at a glance, for the line above a conversation's title: in
 * primitives and marks only, never a step or a question's words, so a child's
 * streaming transcript cannot redraw the header. Null when there is no family.
 */
export interface TaskFamilyGlance {
  /** Up to three running children's marks, the ones that need the reader first. */
  readonly marks: readonly TaskMark[];
  readonly running: number;
  readonly needsYou: boolean;
  readonly automations: number;
  readonly earlier: number;
}

export const familyGlanceMarks = 3;

export function taskFamilyGlance(reader: FamilyReader, threadId: string): TaskFamilyGlance | null {
  const { open, settled } = children(reader.assignments, threadId);
  const automations = reader.threadAutomations[threadId]?.length ?? 0;
  if (open.length === 0 && settled.length === 0 && automations === 0) return null;
  const asking = open.map(
    (assignment) =>
      [
        assignment,
        requestWaitingOnAssignment(reader.waitingRequests, assignment.id) !== null,
      ] as const,
  );
  // `sort` is stable and mutates this fresh array; Hermes lacks `toSorted`.
  asking.sort(([, left], [, right]) => Number(right) - Number(left));
  return {
    marks: asking
      .slice(0, familyGlanceMarks)
      .map(([assignment]) => assignmentMark(assignment, reader)),
    running: open.length,
    needsYou: asking.some(([, needsYou]) => needsYou),
    automations,
    earlier: settled.length,
  };
}

export function sameTaskFamilyGlance(
  left: TaskFamilyGlance | null,
  right: TaskFamilyGlance | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.running === right.running &&
    left.needsYou === right.needsYou &&
    left.automations === right.automations &&
    left.earlier === right.earlier &&
    left.marks.length === right.marks.length &&
    left.marks.every((mark, index) => sameMark(mark, right.marks[index]))
  );
}

/** Rows are rebuilt on every change a family hears, so identity says nothing. */
export function sameTaskFamily(left: TaskFamily, right: TaskFamily): boolean {
  return (
    sameList(left.running, right.running, sameFamilyTask) &&
    sameList(left.earlier, right.earlier, sameFamilyTask) &&
    sameList(left.automations, right.automations, sameAutomation)
  );
}

/**
 * Each worker this conversation handed work to, once: its open Assignment
 * while it has one, otherwise the one that settled last.
 */
function children(
  assignments: Readonly<Record<string, AssignmentSummary>>,
  threadId: string,
): { readonly open: AssignmentSummary[]; readonly settled: AssignmentSummary[] } {
  const byWorker = new Map<string, AssignmentSummary>();
  for (const assignment of Object.values(assignments)) {
    const worker = assignment.workerThread.id;
    if (assignment.parentThreadId !== threadId || worker === threadId) continue;
    const held = byWorker.get(worker);
    if (held === undefined || outranks(assignment, held)) byWorker.set(worker, assignment);
  }
  const open: AssignmentSummary[] = [];
  const settled: AssignmentSummary[] = [];
  for (const assignment of byWorker.values())
    (assignment.status === "open" ? open : settled).push(assignment);
  open.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  settled.sort(
    (left, right) =>
      (right.finishedAt ?? right.updatedAt).localeCompare(left.finishedAt ?? left.updatedAt) ||
      right.id.localeCompare(left.id),
  );
  return { open, settled };
}

function outranks(candidate: AssignmentSummary, held: AssignmentSummary): boolean {
  const open = Number(candidate.status === "open") - Number(held.status === "open");
  if (open !== 0) return open > 0;
  return (
    candidate.createdAt.localeCompare(held.createdAt) > 0 ||
    (candidate.createdAt === held.createdAt && candidate.id.localeCompare(held.id) > 0)
  );
}

function familyTask(assignment: AssignmentSummary, reader: FamilyReader): FamilyTask {
  const presentation = assignmentPresentation(assignment, reader);
  return {
    threadId: assignment.workerThread.id,
    assignmentId: assignment.id,
    title: assignmentTitle(assignment, reader),
    mark: assignmentMark(assignment, reader),
    word: presentation.word,
    tone: presentation.tone,
    moving: presentation.moving,
    needsYou:
      presentation.open &&
      requestWaitingOnAssignment(reader.waitingRequests, assignment.id) !== null,
    detail: presentation.detail?.text ?? null,
    finishedAt: assignment.finishedAt,
  };
}

function arrangedAutomations(
  automations: readonly ThreadAutomation[],
): readonly ThreadAutomation[] {
  if (automations.length < 2) return automations;
  return [...automations].sort(
    (left, right) =>
      Number(left.paused) - Number(right.paused) ||
      (left.nextFireAt ?? "￿").localeCompare(right.nextFireAt ?? "￿") ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

function sameFamilyTask(left: FamilyTask, right: FamilyTask): boolean {
  return (
    left.threadId === right.threadId &&
    left.assignmentId === right.assignmentId &&
    left.title === right.title &&
    sameMark(left.mark, right.mark) &&
    left.word === right.word &&
    left.tone === right.tone &&
    left.moving === right.moving &&
    left.needsYou === right.needsYou &&
    left.detail === right.detail &&
    left.finishedAt === right.finishedAt
  );
}

function sameAutomation(left: ThreadAutomation, right: ThreadAutomation): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.kind === right.kind &&
    left.paused === right.paused &&
    left.nextFireAt === right.nextFireAt
  );
}

function sameMark(left: TaskMark, right: TaskMark | undefined): boolean {
  return right !== undefined && left.icon === right.icon && left.color === right.color;
}

function sameList<T>(
  left: readonly T[],
  right: readonly T[],
  same: (left: T, right: T) => boolean,
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return other !== undefined && same(item, other);
    })
  );
}
