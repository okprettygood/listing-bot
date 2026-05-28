// app/components/batch-grouping.tsx
"use client";

import { groupBadgeClass, nextGroupFor } from "@/app/batch-types";
import type { BatchAssignments } from "@/app/batch-types";

type Photo = { id: string; file: File; url: string };

type Props = {
  photos: Photo[];
  assignments: BatchAssignments;
  onAssign: (photoId: string, group: number | null) => void;
  onGenerate: () => void;
};

export function BatchGroupingScreen({
  photos,
  assignments,
  onAssign,
  onGenerate,
}: Props) {
  const ungroupedCount = photos.filter(
    (p) => (assignments[p.id] ?? null) === null,
  ).length;

  const groupSummary = (() => {
    const counts: Record<number, number> = {};
    for (const g of Object.values(assignments)) {
      if (g !== null) counts[g] = (counts[g] ?? 0) + 1;
    }
    return Object.entries(counts)
      .map(([id, count]) => ({ id: Number(id), count }))
      .sort((a, b) => a.id - b.id);
  })();

  function handleTap(photoId: string) {
    onAssign(photoId, nextGroupFor(photoId, assignments));
  }

  const canGenerate = ungroupedCount === 0 && photos.length > 0;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-neutral-200 bg-white px-4 py-3">
        <h2 className="text-base font-semibold text-neutral-900">
          Group your photos
        </h2>
        <p className="mt-0.5 text-xs text-neutral-500">
          Tap each photo to assign it to an item. Tap again to change groups.
        </p>
      </div>

      {/* Photo grid */}
      <div className="flex-1 px-4 py-4">
        <ul className="grid grid-cols-3 gap-2">
          {photos.map((p) => {
            const group = assignments[p.id] ?? null;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => handleTap(p.id)}
                  className="relative aspect-square w-full overflow-hidden rounded-lg border-2 border-neutral-200 bg-neutral-100 focus:outline-none active:scale-95"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  {/* Dim unassigned photos */}
                  {group === null && (
                    <div className="absolute inset-0 bg-black/35" />
                  )}
                  {/* Group badge */}
                  {group !== null && (
                    <span
                      className={`absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold shadow-md ${groupBadgeClass(group)}`}
                    >
                      {group}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Sticky bottom panel */}
      <div className="sticky bottom-0 border-t border-neutral-200 bg-white px-4 pb-8 pt-3">
        {ungroupedCount > 0 && (
          <p className="mb-2 text-center text-xs text-amber-700">
            {ungroupedCount} photo{ungroupedCount !== 1 ? "s" : ""} not assigned
            to an item
          </p>
        )}

        {groupSummary.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2">
            {groupSummary.map(({ id, count }) => (
              <span
                key={id}
                className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${groupBadgeClass(id)}`}
              >
                Item {id}
                <span className="opacity-75">· {count}</span>
              </span>
            ))}
          </div>
        )}

        <button
          type="button"
          onClick={onGenerate}
          disabled={!canGenerate}
          className="w-full rounded-xl bg-neutral-900 px-4 py-3.5 text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate &amp; save drafts
        </button>
      </div>
    </div>
  );
}
