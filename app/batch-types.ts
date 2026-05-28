// app/batch-types.ts

export type BatchItemStatus =
  | { phase: "waiting" }
  | { phase: "generating" }
  | { phase: "saving_draft" }
  | { phase: "drafted" }
  | { phase: "error"; message: string };

export type BatchItemResult = {
  groupId: number;      // 1-based
  photoCount: number;
  title: string | null; // null until generation succeeds
  status: BatchItemStatus;
};

/** Map from photo ID → group number (1-based) or null if unassigned. */
export type BatchAssignments = Record<string, number | null>;

/**
 * Returns the next group assignment when a photo is tapped.
 *
 * Cycle: null → 1 → 2 → … → maxGroup → null
 * Creating a new group (maxGroup+1) only happens when other photos
 * remain in the current group — prevents runaway group creation.
 */
export function nextGroupFor(
  photoId: string,
  assignments: BatchAssignments,
): number | null {
  const current = assignments[photoId] ?? null;
  const allGroups = Object.values(assignments).filter(
    (v): v is number => v !== null,
  );
  const maxGroup = allGroups.length > 0 ? Math.max(...allGroups) : 0;

  if (current === null) return 1;
  if (current < maxGroup) return current + 1;

  // current === maxGroup: only create a new group if other photos stay here
  const othersInGroup = Object.entries(assignments).filter(
    ([id, g]) => id !== photoId && g === current,
  ).length;
  return othersInGroup > 0 ? current + 1 : null;
}

/**
 * Tailwind bg+text classes for group badge.
 * Index = groupId - 1; falls back to gray for group 6+.
 */
const GROUP_BADGE_CLASSES = [
  "bg-blue-500 text-white",
  "bg-green-500 text-white",
  "bg-orange-500 text-white",
  "bg-purple-500 text-white",
  "bg-red-500 text-white",
];
const GROUP_BADGE_FALLBACK = "bg-gray-500 text-white";

export function groupBadgeClass(groupId: number): string {
  return GROUP_BADGE_CLASSES[Math.max(0, groupId - 1)] ?? GROUP_BADGE_FALLBACK;
}
