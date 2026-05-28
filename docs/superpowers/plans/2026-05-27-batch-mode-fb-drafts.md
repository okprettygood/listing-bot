# Batch Mode with FB Marketplace Draft Saving Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a batch mode that lets the user group uploaded photos into items, then sequentially generates listings and saves each as a Facebook Marketplace draft — all without auto-publishing anything.

**Architecture:** Batch is a parallel state machine in `page.tsx` — three new stages (`batch_grouping`, `batch_generating`, `batch_complete`) coexist alongside the existing single-item stages with zero interference. Three focused screen components handle the batch UI. The sequential queue loop is a plain `async` function fired by a button click; it updates React state throughout to drive the live progress display. The FB publisher gains a `mode: "draft" | "review"` parameter so it can click "Save draft" after filling the form instead of stopping for manual review.

**Tech Stack:** React 18, Next.js App Router, Playwright (fb-publisher), TypeScript, Tailwind CSS

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `app/batch-types.ts` | **Create** | All batch TypeScript types, group-cycle logic, color constants |
| `app/components/batch-grouping.tsx` | **Create** | Photo grouping screen (grid + tap-to-cycle + groups panel) |
| `app/components/batch-progress.tsx` | **Create** | Generation queue progress screen with countdown |
| `app/components/batch-complete.tsx` | **Create** | Completion summary + "Open drafts" link |
| `lib/fb-publisher.ts` | **Modify** | Add `mode` param; draft mode clicks "Save draft" button |
| `app/api/publish/route.ts` | **Modify** | Accept `mode` in body; skip rate-limit for draft mode |
| `app/page.tsx` | **Modify** | Batch toggle, new stage rendering, queue loop, state resets |

---

### Task 1: Shared Batch Types

**Files:**
- Create: `app/batch-types.ts`

- [ ] **Step 1: Create the file**

```typescript
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
  return GROUP_BADGE_CLASSES[groupId - 1] ?? GROUP_BADGE_FALLBACK;
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/batch-types.ts
git commit -m "feat: shared batch types, group-cycle helper, color constants"
```

---

### Task 2: FB Publisher — Draft Mode

**Files:**
- Modify: `lib/fb-publisher.ts`

- [ ] **Step 1: Update `PublishInput` and `PublishResult` types**

Find and replace the two exported type definitions:

```typescript
export type PublishInput = {
  title: string;
  description: string;
  price: number;
  condition: string;
  category?: string;
  photos: string[];
  /** "review" (default): fill form, leave browser open for manual Next→Publish.
   *  "draft": fill form, click "Save draft", close browser. */
  mode?: "draft" | "review";
};

export type PublishResult = {
  success: boolean;
  url?: string;
  error?: string;
  screenshot?: string;
  /** true when publisher stopped after filling — user must click Next→Publish manually */
  readyToReview?: boolean;
  /** true when "Save draft" was clicked and confirmed */
  drafted?: boolean;
};
```

- [ ] **Step 2: Replace the hand-off block at the end of the try body**

Find this block (the last lines before the `} catch` in the try):

```typescript
    // ── Hand off to user ──────────────────────────────────────────────────
    // All fields are filled. Take a screenshot so the phone can show a
    // preview, then leave the browser open so the user can click
    // Next → Publish themselves. Never auto-submit.
    await jitter(500, 800); // let any UI settle
    const reviewShot = await snapshot(page, "ready");
    keepBrowserOpen = true;
    return { success: true, readyToReview: true, screenshot: reviewShot };
```

Replace it with:

```typescript
    // ── Hand off or save draft ────────────────────────────────────────────
    await jitter(500, 800); // let any UI settle

    if ((input.mode ?? "review") === "review") {
      const reviewShot = await snapshot(page, "ready");
      keepBrowserOpen = true;
      return { success: true, readyToReview: true, screenshot: reviewShot };
    }

    // ── Draft mode: click "Save draft" ────────────────────────────────────
    const saveDraftBtn = page
      .getByRole("button", { name: /save\s*(?:as\s*)?draft/i })
      .or(page.locator("a", { hasText: /save\s*(?:as\s*)?draft/i }))
      .first();

    const draftBtnVisible = await saveDraftBtn
      .waitFor({ state: "visible", timeout: 8000 })
      .then(() => true)
      .catch(() => false);

    if (!draftBtnVisible) {
      return fail(
        "selector_failed: Save draft button not found — FB may have changed its UI",
        await snapshot(page, "no-save-draft-btn"),
      );
    }

    await saveDraftBtn.click();
    await jitter(1500, 2500); // wait for FB to process the save

    const draftShot = await snapshot(page, "draft-saved");
    return { success: true, drafted: true, screenshot: draftShot };
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add lib/fb-publisher.ts
git commit -m "feat: fb-publisher draft mode — clicks Save draft instead of stopping"
```

---

### Task 3: Publish API — Accept Mode, Skip Rate-Limit for Drafts

**Files:**
- Modify: `app/api/publish/route.ts`

- [ ] **Step 1: Update the `Body` type**

Find:

```typescript
type Body = {
  platform?: string;
  listingId?: string;
  listing?: {
```

Replace with:

```typescript
type Body = {
  platform?: string;
  listingId?: string;
  mode?: "draft" | "review";
  listing?: {
```

- [ ] **Step 2: Skip rate-limit check for draft mode and pass `mode` to the publisher**

Find the block starting with `const limit = checkRateLimit("facebook");` and ending with the closing brace of the rate-limit if-block. Replace the rate-limit check block and the `input` construction:

```typescript
  // Rate-limit only applies to live publishes, not drafts.
  const effectiveMode = body.mode === "draft" ? "draft" : "review";
  if (effectiveMode === "review") {
    const limit = checkRateLimit("facebook");
    if (!limit.ok) {
      return NextResponse.json(
        {
          success: false,
          error: limit.reason,
          waitMs: limit.reason === "too_soon" ? limit.waitMs : undefined,
        },
        { status: 429 },
      );
    }
  }
```

Then find:

```typescript
  const input: PublishInput = {
    title: l.title.trim(),
    description: l.description.trim(),
    price: l.price,
    condition: l.condition,
    category: l.category,
    photos: photoPaths,
  };
```

Replace with:

```typescript
  const input: PublishInput = {
    title: l.title.trim(),
    description: l.description.trim(),
    price: l.price,
    condition: l.condition,
    category: l.category,
    photos: photoPaths,
    mode: effectiveMode,
  };
```

Then find:

```typescript
  if (result.success) recordPublish("facebook");
```

Replace with:

```typescript
  // Only record in rate-limit history for live publishes (not drafts).
  if (result.success && effectiveMode === "review") recordPublish("facebook");
```

- [ ] **Step 3: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/api/publish/route.ts
git commit -m "feat: publish API accepts mode param, skips rate-limit for draft saves"
```

---

### Task 4: Batch Grouping Screen

**Files:**
- Create: `app/components/batch-grouping.tsx`

- [ ] **Step 1: Create the directory and file**

```bash
mkdir -p /Users/prettygood/code/listing-bot/app/components
```

```tsx
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
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/batch-grouping.tsx
git commit -m "feat: batch grouping screen — tap-to-cycle photo assignment, groups panel"
```

---

### Task 5: Batch Progress Screen

**Files:**
- Create: `app/components/batch-progress.tsx`

- [ ] **Step 1: Create the file**

```tsx
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
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/batch-progress.tsx
git commit -m "feat: batch progress screen with per-item status icons and cooldown countdown"
```

---

### Task 6: Batch Complete Screen

**Files:**
- Create: `app/components/batch-complete.tsx`

- [ ] **Step 1: Create the file**

```tsx
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
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/batch-complete.tsx
git commit -m "feat: batch complete screen — draft count summary, failures list, open-drafts link"
```

---

### Task 7: Wire Batch Mode into page.tsx

**Files:**
- Modify: `app/page.tsx`

This is the largest task. Work through each sub-step in order.

- [ ] **Step 1: Add imports at the top of the file**

After the `"use client";` line, add these imports (before the existing `useEffect` / `useRef` / `useState` import):

```tsx
import {
  type BatchAssignments,
  type BatchItemResult,
  nextGroupFor,
} from "@/app/batch-types";
import { BatchGroupingScreen } from "@/app/components/batch-grouping";
import { BatchProgressScreen } from "@/app/components/batch-progress";
import { BatchCompleteScreen } from "@/app/components/batch-complete";
```

- [ ] **Step 2: Extend the `Stage` type**

Find:

```typescript
type Stage = "upload" | "loading" | "results";
```

Replace with:

```typescript
type Stage =
  | "upload"
  | "loading"
  | "results"
  | "batch_grouping"
  | "batch_generating"
  | "batch_complete";
```

- [ ] **Step 3: Add batch state variables inside the `Page` function**

After the existing state declarations (after `const fileInputRef = ...`), add:

```typescript
  // ── Batch mode state ────────────────────────────────────────────────────
  const [batchMode, setBatchMode] = useState(false);
  const [batchAssignments, setBatchAssignments] = useState<BatchAssignments>({});
  const [batchResults, setBatchResults] = useState<BatchItemResult[]>([]);
  const [batchCooldown, setBatchCooldown] = useState<number | null>(null);
  const [batchActiveIndex, setBatchActiveIndex] = useState(0);
```

- [ ] **Step 4: Update `handleFilesAdded` to respect the batch photo cap**

Replace the entire `handleFilesAdded` function with:

```typescript
  function handleFilesAdded(files: FileList | null) {
    if (!files) return;
    const incoming = Array.from(files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (incoming.length === 0) return;
    const cap = batchMode ? 40 : 8;
    setPhotos((prev) => {
      const room = cap - prev.length;
      if (room <= 0) return prev;
      const next = incoming.slice(0, room).map((file) => ({
        id: `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`,
        file,
        url: URL.createObjectURL(file),
      }));
      return [...prev, ...next];
    });
  }
```

- [ ] **Step 5: Update `startOver` to reset batch state**

Replace the existing `startOver` function with:

```typescript
  function startOver() {
    photos.forEach((p) => URL.revokeObjectURL(p.url));
    setPhotos([]);
    setContext("");
    setListing(null);
    setComps(null);
    setListingId(null);
    setPublishState({ status: "idle" });
    setError(null);
    setStage("upload");
    setBatchAssignments({});
    setBatchResults([]);
    setBatchCooldown(null);
    setBatchActiveIndex(0);
    // Intentionally keep batchMode — user's preference persists between batches
  }
```

- [ ] **Step 6: Add `handleBatchGroupingStart` after `handleGenerate`**

```typescript
  function handleBatchGroupingStart() {
    if (photos.length === 0) return;
    // Initialize all photos as unassigned
    const initial: BatchAssignments = {};
    for (const p of photos) initial[p.id] = null;
    setBatchAssignments(initial);
    setStage("batch_grouping");
  }
```

- [ ] **Step 7: Add `runBatchQueue` after `handleBatchGroupingStart`**

```typescript
  async function runBatchQueue() {
    // ── Build ordered groups from current assignments ──────────────────────
    const groupIds = [
      ...new Set(
        Object.values(batchAssignments).filter((v): v is number => v !== null),
      ),
    ].sort((a, b) => a - b);

    const photosByGroup: Record<number, File[]> = {};
    for (const [photoId, groupId] of Object.entries(batchAssignments)) {
      if (groupId === null) continue;
      const photo = photos.find((p) => p.id === photoId);
      if (!photo) continue;
      if (!photosByGroup[groupId]) photosByGroup[groupId] = [];
      photosByGroup[groupId].push(photo.file);
    }

    // ── Initialize results and switch to progress screen ──────────────────
    const initialResults: BatchItemResult[] = groupIds.map((id) => ({
      groupId: id,
      photoCount: photosByGroup[id]?.length ?? 0,
      title: null,
      status: { phase: "waiting" },
    }));
    setBatchResults(initialResults);
    setBatchActiveIndex(0);
    setStage("batch_generating");

    // Work on a mutable copy; call setBatchResults after each mutation
    const results: BatchItemResult[] = initialResults.map((r) => ({ ...r }));

    for (let i = 0; i < groupIds.length; i++) {
      const groupId = groupIds[i];
      const groupPhotos = photosByGroup[groupId] ?? [];
      setBatchActiveIndex(i);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((r) => setTimeout(r, 5000)); // 5s before retry
        }

        // ── Generate listing ────────────────────────────────────────────
        results[i] = { ...results[i], status: { phase: "generating" } };
        setBatchResults([...results]);

        type GenData = {
          listingId?: string;
          listing?: {
            title: string;
            description: string;
            price: number | null;
            condition: string;
            category?: string;
          };
          error?: string;
        };
        let genData: GenData;

        try {
          const form = new FormData();
          for (const f of groupPhotos) form.append("photos", f);
          const genRes = await fetch("/api/generate", {
            method: "POST",
            body: form,
          });
          genData = (await genRes.json()) as GenData;
          if (!genRes.ok || !genData.listing || !genData.listingId) {
            throw new Error(
              genData.error ?? `Generate failed (${genRes.status})`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Generate failed";
          if (attempt < 1) continue; // will retry
          results[i] = { ...results[i], status: { phase: "error", message: msg } };
          setBatchResults([...results]);
          break;
        }

        // ── Save draft ──────────────────────────────────────────────────
        results[i] = {
          ...results[i],
          title: genData.listing!.title,
          status: { phase: "saving_draft" },
        };
        setBatchResults([...results]);

        type PubData = { success?: boolean; error?: string };
        let pubData: PubData;

        try {
          const pubRes = await fetch("/api/publish", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: "facebook",
              mode: "draft",
              listingId: genData.listingId,
              listing: {
                title: genData.listing!.title,
                description: genData.listing!.description,
                price: genData.listing!.price,
                condition: genData.listing!.condition,
                category: genData.listing!.category,
              },
            }),
          });
          pubData = (await pubRes.json()) as PubData;
          if (!pubData.success) {
            throw new Error(
              pubData.error ?? `Draft save failed (${pubRes.status})`,
            );
          }
        } catch (err) {
          const msg =
            err instanceof Error ? err.message : "Draft save failed";
          if (attempt < 1) continue; // will retry
          results[i] = { ...results[i], status: { phase: "error", message: msg } };
          setBatchResults([...results]);
          break;
        }

        // ── Success ─────────────────────────────────────────────────────
        results[i] = { ...results[i], status: { phase: "drafted" } };
        setBatchResults([...results]);
        break; // exit retry loop
      }

      // ── 30s cooldown before next item (skip after last) ──────────────
      if (i < groupIds.length - 1) {
        for (let s = 30; s > 0; s--) {
          setBatchCooldown(s);
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
        setBatchCooldown(null);
      }
    }

    setStage("batch_complete");
  }
```

- [ ] **Step 8: Add batch screen rendering to the JSX `return` block**

In the `return (...)` block of the `Page` component, after the closing brace of the `{stage === "results" && ...}` block and before `</main>`, add:

```tsx
      {stage === "batch_grouping" && (
        <BatchGroupingScreen
          photos={photos}
          assignments={batchAssignments}
          onAssign={(photoId, group) =>
            setBatchAssignments((prev) => ({ ...prev, [photoId]: group }))
          }
          onGenerate={runBatchQueue}
        />
      )}

      {stage === "batch_generating" && (
        <BatchProgressScreen
          items={batchResults}
          cooldown={batchCooldown}
          activeIndex={batchActiveIndex}
        />
      )}

      {stage === "batch_complete" && (
        <BatchCompleteScreen
          items={batchResults}
          onStartOver={startOver}
        />
      )}
```

- [ ] **Step 9: Update `UploadStage` props type to include batch props**

Find the `UploadStage` function signature:

```typescript
function UploadStage({
  photos,
  context,
  onContextChange,
  onFilesAdded,
  onRemove,
  onGenerate,
  fileInputRef,
}: {
  photos: Photo[];
  context: string;
  onContextChange: (v: string) => void;
  onFilesAdded: (f: FileList | null) => void;
  onRemove: (id: string) => void;
  onGenerate: () => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
})
```

Replace with:

```typescript
function UploadStage({
  photos,
  context,
  onContextChange,
  onFilesAdded,
  onRemove,
  onGenerate,
  onBatchGenerate,
  batchMode,
  onBatchModeChange,
  fileInputRef,
}: {
  photos: Photo[];
  context: string;
  onContextChange: (v: string) => void;
  onFilesAdded: (f: FileList | null) => void;
  onRemove: (id: string) => void;
  onGenerate: () => void;
  onBatchGenerate: () => void;
  batchMode: boolean;
  onBatchModeChange: (v: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
})
```

- [ ] **Step 10: Replace the `UploadStage` function body**

Replace everything inside the `UploadStage` function body (the `return (...)` statement) with:

```tsx
  const cap = batchMode ? 40 : 8;
  const atCap = photos.length >= cap;

  return (
    <div className="space-y-5">
      {/* Batch mode toggle */}
      <div className="flex items-center justify-between rounded-xl border border-neutral-200 bg-white px-4 py-3">
        <div>
          <p className="text-sm font-medium text-neutral-800">Batch mode</p>
          <p className="text-xs text-neutral-500">
            Generate multiple listings at once
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={batchMode}
          onClick={() => onBatchModeChange(!batchMode)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none ${
            batchMode ? "bg-neutral-900" : "bg-neutral-300"
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
              batchMode ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {batchMode && (
        <p className="rounded-xl border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          Upload photos for multiple items. Group them, generate all listings,
          and save as FB Marketplace drafts for review.
        </p>
      )}

      <div>
        <label
          htmlFor="photos"
          className="block text-sm font-medium text-neutral-800"
        >
          Photos{" "}
          <span className="text-neutral-500">
            ({photos.length}/{cap})
          </span>
        </label>
        <div className="mt-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={atCap}
            className="flex w-full items-center justify-center rounded-xl border-2 border-dashed border-neutral-300 bg-white px-4 py-6 text-base font-medium text-neutral-700 transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {atCap ? `Max ${cap} photos` : "Take photo or choose images"}
          </button>
          <input
            ref={fileInputRef}
            id="photos"
            type="file"
            multiple
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              onFilesAdded(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {photos.length > 0 && (
          <ul className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photos.map((p) => (
              <li
                key={p.id}
                className="relative aspect-square overflow-hidden rounded-lg border border-neutral-200 bg-neutral-100"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt=""
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemove(p.id)}
                  aria-label="Remove photo"
                  className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white text-sm font-bold leading-none active:scale-95"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <label
          htmlFor="context"
          className="block text-sm font-medium text-neutral-800"
        >
          Extra context (optional)
        </label>
        <textarea
          id="context"
          rows={3}
          value={context}
          onChange={(e) => onContextChange(e.target.value)}
          placeholder="e.g. barely used, original box included"
          className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
        />
      </div>

      {batchMode ? (
        <button
          type="button"
          onClick={onBatchGenerate}
          disabled={photos.length === 0}
          className="w-full rounded-xl bg-neutral-900 px-4 py-3.5 text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Group photos →
        </button>
      ) : (
        <button
          type="button"
          onClick={onGenerate}
          disabled={photos.length === 0}
          className="w-full rounded-xl bg-neutral-900 px-4 py-3.5 text-base font-semibold text-white transition active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Generate listing
        </button>
      )}
    </div>
  );
```

- [ ] **Step 11: Update the `UploadStage` usage in the `Page` JSX**

Find:

```tsx
      {stage === "upload" && (
        <UploadStage
          photos={photos}
          context={context}
          onContextChange={setContext}
          onFilesAdded={handleFilesAdded}
          onRemove={removePhoto}
          onGenerate={handleGenerate}
          fileInputRef={fileInputRef}
        />
      )}
```

Replace with:

```tsx
      {stage === "upload" && (
        <UploadStage
          photos={photos}
          context={context}
          onContextChange={setContext}
          onFilesAdded={handleFilesAdded}
          onRemove={removePhoto}
          onGenerate={handleGenerate}
          onBatchGenerate={handleBatchGroupingStart}
          batchMode={batchMode}
          onBatchModeChange={(v) => {
            setBatchMode(v);
            // Clear loaded photos when switching modes — the cap changes
            if (photos.length > 0) {
              photos.forEach((p) => URL.revokeObjectURL(p.url));
              setPhotos([]);
            }
          }}
          fileInputRef={fileInputRef}
        />
      )}
```

- [ ] **Step 12: Type-check**

```bash
npx tsc --noEmit
```

Expected: no errors. Fix any type errors before committing.

- [ ] **Step 13: Commit**

```bash
git add app/page.tsx
git commit -m "feat: wire batch mode — toggle, grouping stage, queue loop, complete screen"
```

---

### Task 8: Final Verification & Push

- [ ] **Step 1: Run dev server**

```bash
npm run dev
```

Visit `http://localhost:3000`.

- [ ] **Step 2: Verify single-item flow is completely unchanged**

1. Batch mode toggle is **off** by default
2. Upload 1–3 photos → Generate listing → results appear normally
3. "Publish to Facebook Marketplace" button is visible as before
4. Single-item flow works end-to-end — no regressions

- [ ] **Step 3: Verify batch mode UI (no FB session required)**

1. Toggle batch mode **on** — blue hint text appears
2. Upload 6+ photos — confirm cap shows "/40"
3. Tap "Group photos →" — grouping screen appears
4. Tap photos in order — badges appear (blue=1, green=2, orange=3…)
5. Dimmed overlay on unassigned photos
6. Groups panel at bottom updates with photo counts
7. Ungrouped count shows while photos remain unassigned
8. "Generate & save drafts" stays disabled until all photos are assigned
9. Assign all photos — button enables
10. Tap a badged photo — cycles to next group; tap the highest-group photo with others → new group; alone at top → unassigns

- [ ] **Step 4: Push**

```bash
git push
```

---

## Known Limitation — "Save Draft" Selector

`lib/fb-publisher.ts` in draft mode looks for:

```
button[role="button"] with accessible name matching /save\s*(?:as\s*)?draft/i
```

If Facebook changes their UI or the button has a different label, this will fail with `selector_failed: Save draft button not found`. The debug screenshot at `data/debug/fb-no-save-draft-btn-{timestamp}.png` will show exactly what the page looks like at that point, which makes adjusting the selector straightforward.
