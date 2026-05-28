// app/components/batch-complete.tsx
"use client";

import type { BatchItemResult } from "@/app/batch-types";

type Props = {
  items: BatchItemResult[];
  onStartOver: () => void;
};

export function BatchCompleteScreen({ items, onStartOver }: Props) {
  const draftedCount = items.filter((i) => i.status.phase === "drafted").length;
  const failedItems = items.filter((i) => i.status.phase === "error");

  return (
    <div className="space-y-5 py-4">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-5 text-center">
        <p className="text-3xl">🎉</p>
        <p className="mt-2 text-lg font-semibold text-emerald-900">
          {draftedCount} draft{draftedCount !== 1 ? "s" : ""} saved to Facebook
          Marketplace
        </p>
        <p className="mt-1 text-sm text-emerald-700">
          Open Facebook Marketplace to review and publish your drafts.
        </p>
      </div>

      {failedItems.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="mb-2 text-sm font-semibold text-red-800">
            {failedItems.length} item{failedItems.length !== 1 ? "s" : ""}{" "}
            failed:
          </p>
          <ul className="space-y-1">
            {failedItems.map((item) => (
              <li key={item.groupId} className="text-sm text-red-700">
                Item {item.groupId}
                {item.title ? ` — ${item.title}` : ""}
                {item.status.phase === "error"
                  ? `: ${item.status.message}`
                  : ""}
              </li>
            ))}
          </ul>
        </div>
      )}

      <a
        href="https://www.facebook.com/marketplace/you/selling"
        target="_blank"
        rel="noopener noreferrer"
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#1877F2] px-4 py-3.5 text-base font-semibold text-white transition active:scale-[0.99]"
      >
        Open FB Marketplace drafts →
      </a>

      <button
        type="button"
        onClick={onStartOver}
        className="w-full rounded-xl px-4 py-3 text-sm font-medium text-neutral-500 active:text-neutral-700"
      >
        Start over
      </button>
    </div>
  );
}
