// app/components/batch-progress.tsx
"use client";

import type { BatchItemResult } from "@/app/batch-types";

type Props = {
  items: BatchItemResult[];
  /** Seconds remaining in the inter-item cooldown, null when not cooling down. */
  cooldown: number | null;
  /** Index of the item currently being processed (or in post-draft cooldown). */
  activeIndex: number;
};

export function BatchProgressScreen({ items, cooldown, activeIndex }: Props) {
  return (
    <div className="py-2">
      <h2 className="mb-4 text-lg font-semibold text-neutral-900">
        Saving drafts…
      </h2>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <ProgressRow
            key={item.groupId}
            item={item}
            // Show countdown on the row of the item that just drafted,
            // while we wait before starting the next one.
            cooldown={
              index === activeIndex &&
              item.status.phase === "drafted" &&
              cooldown !== null
                ? cooldown
                : null
            }
          />
        ))}
      </ul>
    </div>
  );
}

function ProgressRow({
  item,
  cooldown,
}: {
  item: BatchItemResult;
  cooldown: number | null;
}) {
  const { status } = item;
  const displayName =
    item.title ??
    `Item ${item.groupId} (${item.photoCount} photo${item.photoCount !== 1 ? "s" : ""})`;

  return (
    <li className="rounded-xl border border-neutral-200 bg-white px-4 py-3">
      <div className="flex items-center gap-3">
        <StatusIcon phase={status.phase} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-neutral-900">
            {displayName}
          </p>
          <p className="mt-0.5 text-xs text-neutral-500">
            <StatusLabel phase={status.phase} />
          </p>
        </div>
      </div>

      {status.phase === "error" && (
        <p className="mt-1.5 break-words text-xs text-red-600">
          {status.message}
        </p>
      )}

      {cooldown !== null && cooldown > 0 && (
        <p className="mt-1.5 text-xs text-neutral-400">
          Next item in {cooldown}s…
        </p>
      )}
    </li>
  );
}

function StatusIcon({ phase }: { phase: string }) {
  switch (phase) {
    case "waiting":
      return (
        <div className="h-5 w-5 shrink-0 rounded-full border-2 border-neutral-300 bg-white" />
      );
    case "generating":
    case "saving_draft":
      return (
        <div
          aria-hidden="true"
          className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
        />
      );
    case "drafted":
      return (
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            fill="none"
            className="h-3 w-3"
          >
            <path
              d="M2 6l3 3 5-5"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      );
    case "error":
      return (
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white">
          !
        </div>
      );
    default:
      return <div className="h-5 w-5 shrink-0" />;
  }
}

function StatusLabel({ phase }: { phase: string }) {
  switch (phase) {
    case "waiting":        return <>Waiting</>;
    case "generating":     return <>Generating listing…</>;
    case "saving_draft":   return <>Saving draft on Facebook…</>;
    case "drafted":        return <>Draft saved ✓</>;
    case "error":          return <>Failed</>;
    default:               return null;
  }
}
