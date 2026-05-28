"use client";

import {
  type BatchAssignments,
  type BatchItemResult,
} from "@/app/batch-types";
import { BatchGroupingScreen } from "@/app/components/batch-grouping";
import { BatchProgressScreen } from "@/app/components/batch-progress";
import { BatchCompleteScreen } from "@/app/components/batch-complete";
import { useEffect, useRef, useState } from "react";

type Condition = "new" | "like_new" | "good" | "fair" | "poor";
type Confidence = "high" | "medium" | "low";

type Listing = {
  title: string;
  description: string;
  condition: Condition;
  suggested_price: number | null;
  price_reasoning: string;
  identified_item: {
    brand: string | null;
    model: string | null;
    category_guess: string;
  };
  confidence: Confidence;
  notes_for_seller: string;
};

type Comp = {
  title: string;
  price: number;
  distance: string;
  url: string;
  imageUrl: string | null;
};

type CompStats = {
  count: number;
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
};

type ScrapeError =
  | "blocked"
  | "no_results"
  | "failed"
  | "session_expired";

type SourceResult =
  | { listings: Comp[]; stats: CompStats; error?: undefined }
  | { listings: []; stats: null; error: ScrapeError };

type CompResponse = {
  query: string;
  offerup: SourceResult;
  facebook: SourceResult;
  ebay: SourceResult;
} | null;

type PublishState =
  | { status: "idle" }
  | { status: "publishing" }
  | { status: "ready_to_review"; screenshot?: string }
  | { status: "awaiting_url" }
  | { status: "success"; url?: string }
  | { status: "error"; error: string; screenshot?: string };

type Photo = {
  id: string;
  file: File;
  url: string;
};

type Stage =
  | "upload"
  | "loading"
  | "results"
  | "batch_grouping"
  | "batch_generating"
  | "batch_complete";

const CONDITIONS: { value: Condition; label: string }[] = [
  { value: "new", label: "New" },
  { value: "like_new", label: "Like new" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "poor", label: "Poor" },
];

const COND_LABEL: Record<Condition, string> = {
  new: "New",
  like_new: "Like new",
  good: "Good",
  fair: "Fair",
  poor: "Poor",
};

function friendlyError(code: string | undefined, waitMs?: number): string {
  switch (code) {
    case "session_not_set_up":
      return "FB session not set up. Run: npx tsx scripts/fb-login.ts";
    case "session_expired":
      return "FB session expired. Re-run scripts/fb-login.ts.";
    case "captcha":
      return "Facebook showed a captcha. Try again later.";
    case "daily_limit":
      return "Daily limit reached (10/day). Try again tomorrow.";
    case "too_soon": {
      const s = waitMs ? Math.ceil(waitMs / 1000) : 60;
      return `Too soon since last publish. Wait ${s}s.`;
    }
    case "photos_not_found":
    case "no_photos_on_disk":
      return "Photos were not saved on the server. Generate again.";
    case "timeout":
      return "Publishing timed out. Try again.";
    case "invalid_listing_fields":
      return "Listing is missing title, description, price, or condition.";
    default:
      return code ? `Publish failed: ${code}` : "Publish failed.";
  }
}

function copyToClipboard(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(textarea);
  return ok;
}

export default function Page() {
  const [stage, setStage] = useState<Stage>("upload");
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<Listing | null>(null);
  const [comps, setComps] = useState<CompResponse>(null);
  const [listingId, setListingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [publishState, setPublishState] = useState<PublishState>({
    status: "idle",
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Batch mode state ──────────────────────────────────────────────────
  const [batchMode, setBatchMode] = useState(false);
  const [batchAssignments, setBatchAssignments] = useState<BatchAssignments>({});
  const [batchResults, setBatchResults] = useState<BatchItemResult[]>([]);
  const [batchCooldown, setBatchCooldown] = useState<number | null>(null);
  const [batchActiveIndex, setBatchActiveIndex] = useState(0);

  useEffect(() => {
    return () => {
      photos.forEach((p) => URL.revokeObjectURL(p.url));
    };
  }, [photos]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(t);
  }, [copied]);

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

  function removePhoto(id: string) {
    setPhotos((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((p) => p.id !== id);
    });
  }

  async function handleGenerate() {
    if (photos.length === 0) return;
    setError(null);
    setStage("loading");

    const form = new FormData();
    for (const p of photos) form.append("photos", p.file);
    if (context.trim()) form.append("context", context.trim());

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        body: form,
      });
      const data: {
        listingId?: string;
        listing?: Listing;
        comps?: CompResponse;
        error?: string;
      } = await res.json();
      if (!res.ok || !data.listing) {
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }
      setListing(data.listing);
      setComps(data.comps ?? null);
      setListingId(data.listingId ?? null);
      setPublishState({ status: "idle" });
      setStage("results");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Something went wrong.";
      setError(msg);
      setStage("upload");
    }
  }

  function handleBatchGroupingStart() {
    if (photos.length === 0) return;
    const initial: BatchAssignments = {};
    for (const p of photos) initial[p.id] = null;
    setBatchAssignments(initial);
    setStage("batch_grouping");
  }

  async function runBatchQueue() {
    // Build ordered groups from current assignments
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

    // Initialize results and switch to progress screen
    const initialResults: BatchItemResult[] = groupIds.map((id) => ({
      groupId: id,
      photoCount: photosByGroup[id]?.length ?? 0,
      title: null,
      status: { phase: "waiting" },
    }));
    setBatchResults(initialResults);
    setBatchActiveIndex(0);
    setStage("batch_generating");

    const results: BatchItemResult[] = initialResults.map((r) => ({ ...r }));

    for (let i = 0; i < groupIds.length; i++) {
      const groupId = groupIds[i];
      const groupPhotos = photosByGroup[groupId] ?? [];
      setBatchActiveIndex(i);

      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise<void>((r) => setTimeout(r, 5000));
        }

        // Generate listing
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
          if (attempt < 1) continue;
          results[i] = { ...results[i], status: { phase: "error", message: msg } };
          setBatchResults([...results]);
          break;
        }

        // Save draft
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
          const msg = err instanceof Error ? err.message : "Draft save failed";
          if (attempt < 1) continue;
          results[i] = { ...results[i], status: { phase: "error", message: msg } };
          setBatchResults([...results]);
          break;
        }

        // Success
        results[i] = { ...results[i], status: { phase: "drafted" } };
        setBatchResults([...results]);
        break;
      }

      // 30s cooldown before next item only when something was submitted to FB.
      // Skip the delay entirely if this item failed (no FB API call was made).
      if (i < groupIds.length - 1 && results[i].status.phase === "drafted") {
        for (let s = 30; s > 0; s--) {
          setBatchCooldown(s);
          await new Promise<void>((r) => setTimeout(r, 1000));
        }
        setBatchCooldown(null);
      }
    }

    setStage("batch_complete");
  }

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
    // Intentionally keep batchMode — user preference persists between batches
  }

  function copyText(key: string, text: string) {
    if (copyToClipboard(text)) {
      setCopied(key);
    } else {
      setError("Copy failed. Try selecting the text manually.");
    }
  }

  async function publishToFacebook() {
    if (!listing || !listingId) return;
    if (listing.suggested_price == null || listing.suggested_price <= 0) {
      setPublishState({ status: "error", error: "Set a price before publishing." });
      return;
    }
    setPublishState({ status: "publishing" });
    try {
      const res = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: "facebook",
          listingId,
          listing: {
            title: listing.title,
            description: listing.description,
            price: listing.suggested_price,
            condition: listing.condition,
            category: listing.identified_item.category_guess,
          },
        }),
      });
      const data: {
        success?: boolean;
        url?: string;
        error?: string;
        screenshot?: string;
        readyToReview?: boolean;
        waitMs?: number;
      } = await res.json();
      if (data.success && data.readyToReview) {
        setPublishState({ status: "ready_to_review", screenshot: data.screenshot });
      } else if (data.success) {
        setPublishState({ status: "success", url: data.url });
      } else {
        setPublishState({
          status: "error",
          error: friendlyError(data.error, data.waitMs),
          screenshot: data.screenshot,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      setPublishState({ status: "error", error: msg });
    }
  }

  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-6 sm:py-10">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Listing Bot
        </h1>
        <p className="mt-1 text-sm text-neutral-600">
          Snap photos of an item. Get a draft listing.
        </p>
      </header>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          {error}
        </div>
      )}

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
            // Clear loaded photos when switching modes — the cap changes.
            // setPhotos([]) is enough; the useEffect cleanup revokes the URLs.
            if (photos.length > 0) {
              setPhotos([]);
            }
          }}
          fileInputRef={fileInputRef}
        />
      )}

      {stage === "loading" && <LoadingStage />}

      {stage === "results" && listing && (
        <ResultsStage
          listing={listing}
          comps={comps}
          onChange={setListing}
          onStartOver={startOver}
          onCopy={copyText}
          copied={copied}
          publishState={publishState}
          onPublish={publishToFacebook}
          onConfirmPublished={() => setPublishState({ status: "awaiting_url" })}
          onSaveUrl={(url) => setPublishState({ status: "success", url: url || undefined })}
        />
      )}

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
    </main>
  );
}

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
}) {
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
}

function LoadingStage() {
  const messages = [
    "Drafting your listing…",
    "Checking OfferUp comps…",
    "Checking eBay sold prices…",
    "Refining price with market data…",
  ];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const t1 = setTimeout(() => setIndex(1), 12000);
    const t2 = setTimeout(() => setIndex(2), 22000);
    const t3 = setTimeout(() => setIndex(3), 32000);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-neutral-200 bg-white py-16">
      <div
        aria-hidden="true"
        className="h-10 w-10 animate-spin rounded-full border-4 border-neutral-200 border-t-neutral-900"
      />
      <p className="mt-4 text-base font-medium text-neutral-700 transition-opacity duration-300">
        {messages[index]}
      </p>
      <p className="mt-1 text-sm text-neutral-500">
        Usually takes 30–45 seconds.
      </p>
    </div>
  );
}

type Tab = "listing" | "comps" | "notes";

type CombinedStats = {
  p25: number;
  median: number;
  p75: number;
  offerupCount: number;
  fbCount: number;
};

type SoldStats = {
  median: number;
  p25: number;
  p75: number;
  count: number;
};

function getCombinedStats(comps: CompResponse): CombinedStats | null {
  if (!comps) return null;
  const offerup = !comps.offerup.error ? comps.offerup.listings : [];
  const facebook = !comps.facebook.error ? comps.facebook.listings : [];
  const merged = [...offerup, ...facebook];
  if (merged.length === 0) return null;
  const sorted = merged.map((c) => c.price).sort((a, b) => a - b);
  return {
    p25: Math.round(quantile(sorted, 0.25)),
    median: Math.round(quantile(sorted, 0.5)),
    p75: Math.round(quantile(sorted, 0.75)),
    offerupCount: offerup.length,
    fbCount: facebook.length,
  };
}

function getSoldStats(comps: CompResponse): SoldStats | null {
  if (!comps) return null;
  const ebay = !comps.ebay.error ? comps.ebay.listings : [];
  if (ebay.length === 0) return null;
  const sorted = ebay.map((c) => c.price).sort((a, b) => a - b);
  return {
    median: Math.round(quantile(sorted, 0.5)),
    p25: Math.round(quantile(sorted, 0.25)),
    p75: Math.round(quantile(sorted, 0.75)),
    count: ebay.length,
  };
}

function ResultsStage({
  listing,
  comps,
  onChange,
  onStartOver,
  onCopy,
  copied,
  publishState,
  onPublish,
  onConfirmPublished,
  onSaveUrl,
}: {
  listing: Listing;
  comps: CompResponse;
  onChange: (l: Listing) => void;
  onStartOver: () => void;
  onCopy: (key: string, text: string) => void;
  copied: string | null;
  publishState: PublishState;
  onPublish: () => void;
  onConfirmPublished: () => void;
  onSaveUrl: (url: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("listing");
  const combinedStats = getCombinedStats(comps);
  const soldStats = getSoldStats(comps);

  return (
    <div>
      <div className="sticky top-0 z-10 -mx-4 bg-[#fafafa]/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-[#fafafa]/80">
        <div
          role="tablist"
          aria-label="Listing sections"
          className="flex border-b border-neutral-200"
        >
          <TabButton active={tab === "listing"} onClick={() => setTab("listing")}>
            Listing
          </TabButton>
          <TabButton active={tab === "comps"} onClick={() => setTab("comps")}>
            Market comps
          </TabButton>
          <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>
            AI notes
          </TabButton>
        </div>
      </div>

      <div className="pt-5">
        {tab === "listing" && (
          <ListingTab
            listing={listing}
            combinedStats={combinedStats}
            onChange={onChange}
            onStartOver={onStartOver}
            onCopy={onCopy}
            copied={copied}
            publishState={publishState}
            onPublish={onPublish}
            onConfirmPublished={onConfirmPublished}
            onSaveUrl={onSaveUrl}
          />
        )}
        {tab === "comps" && (
          <CompsTab
            comps={comps}
            combinedStats={combinedStats}
            soldStats={soldStats}
            title={listing.title}
          />
        )}
        {tab === "notes" && <NotesTab listing={listing} />}
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex-1 px-2 py-3.5 text-sm font-medium transition-colors ${
        active
          ? "border-b-2 border-neutral-900 text-neutral-900"
          : "border-b-2 border-transparent text-neutral-500 active:text-neutral-700"
      }`}
    >
      {children}
    </button>
  );
}

function ListingTab({
  listing,
  combinedStats,
  onChange,
  onStartOver,
  onCopy,
  copied,
  publishState,
  onPublish,
  onConfirmPublished,
  onSaveUrl,
}: {
  listing: Listing;
  combinedStats: CombinedStats | null;
  onChange: (l: Listing) => void;
  onStartOver: () => void;
  onCopy: (key: string, text: string) => void;
  copied: string | null;
  publishState: PublishState;
  onPublish: () => void;
  onConfirmPublished: () => void;
  onSaveUrl: (url: string) => void;
}) {
  const titleLen = listing.title.length;
  const titleOk = titleLen >= 60 && titleLen <= 80;
  const titleColor = titleOk
    ? "text-emerald-700"
    : titleLen > 80
      ? "text-red-700"
      : "text-neutral-500";

  const priceForCopy =
    listing.suggested_price != null ? `$${listing.suggested_price}` : "TBD";
  const copyAllText = [
    listing.title,
    "",
    listing.description,
    "",
    `Price: ${priceForCopy}`,
    "",
    `Condition: ${COND_LABEL[listing.condition]}`,
  ].join("\n");

  return (
    <div className="space-y-5">
      <Field
        label="Title"
        hint={
          <span className={titleColor}>{titleLen} chars · target 60–80</span>
        }
      >
        <input
          type="text"
          value={listing.title}
          onChange={(e) => onChange({ ...listing, title: e.target.value })}
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
        />
      </Field>

      <Field label="Description">
        <textarea
          rows={8}
          value={listing.description}
          onChange={(e) =>
            onChange({ ...listing, description: e.target.value })
          }
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
        />
      </Field>

      <Field label="Condition">
        <select
          value={listing.condition}
          onChange={(e) =>
            onChange({
              ...listing,
              condition: e.target.value as Condition,
            })
          }
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
        >
          {CONDITIONS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Price ($)">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="1"
          value={listing.suggested_price ?? ""}
          onChange={(e) =>
            onChange({
              ...listing,
              suggested_price:
                e.target.value === "" ? null : Number(e.target.value),
            })
          }
          className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
        />
        {combinedStats && (
          <PriceHealth
            price={listing.suggested_price}
            p25={combinedStats.p25}
            p75={combinedStats.p75}
          />
        )}
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Brand">
          <input
            type="text"
            value={listing.identified_item.brand ?? ""}
            onChange={(e) =>
              onChange({
                ...listing,
                identified_item: {
                  ...listing.identified_item,
                  brand: e.target.value || null,
                },
              })
            }
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
          />
        </Field>
        <Field label="Model">
          <input
            type="text"
            value={listing.identified_item.model ?? ""}
            onChange={(e) =>
              onChange({
                ...listing,
                identified_item: {
                  ...listing.identified_item,
                  model: e.target.value || null,
                },
              })
            }
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-base shadow-sm focus:border-neutral-900 focus:outline-none"
          />
        </Field>
      </div>

      <div className="space-y-2 pt-2">
        <CopyButton
          label="Copy all"
          copied={copied === "all"}
          onClick={() => onCopy("all", copyAllText)}
          primary
        />
        <div className="grid grid-cols-2 gap-2">
          <CopyButton
            label="Copy title"
            copied={copied === "title"}
            onClick={() => onCopy("title", listing.title)}
          />
          <CopyButton
            label="Copy description"
            copied={copied === "description"}
            onClick={() => onCopy("description", listing.description)}
          />
        </div>
      </div>

      <PublishSection
        state={publishState}
        onPublish={onPublish}
        onConfirmPublished={onConfirmPublished}
        onSaveUrl={onSaveUrl}
      />

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

function PublishSection({
  state,
  onPublish,
  onConfirmPublished,
  onSaveUrl,
}: {
  state: PublishState;
  onPublish: () => void;
  onConfirmPublished: () => void;
  onSaveUrl: (url: string) => void;
}) {
  const [urlInput, setUrlInput] = useState("");

  return (
    <div className="space-y-2 border-t border-neutral-200 pt-4">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        Publish directly
      </p>

      {state.status === "publishing" ? (
        <div className="flex items-center justify-center gap-3 rounded-xl border border-neutral-200 bg-white px-4 py-3.5">
          <div
            aria-hidden="true"
            className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-200 border-t-neutral-900"
          />
          <span className="text-sm font-medium text-neutral-700">
            Filling form on Facebook Marketplace…
          </span>
        </div>
      ) : state.status === "ready_to_review" ? (
        <div className="space-y-3 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3.5">
          <p className="text-sm font-medium text-blue-900">
            Form is ready. Review on your laptop and click{" "}
            <span className="font-semibold">Next → Publish</span> yourself.
          </p>
          <button
            type="button"
            onClick={onConfirmPublished}
            className="w-full rounded-lg bg-emerald-600 px-4 py-3 text-sm font-semibold text-white active:scale-[0.99]"
          >
            Done, it&apos;s published
          </button>
        </div>
      ) : state.status === "awaiting_url" ? (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3.5">
          <p className="text-sm font-medium text-emerald-900">
            Nice! Paste the listing URL to save it (optional).
          </p>
          <input
            type="url"
            inputMode="url"
            placeholder="https://www.facebook.com/marketplace/item/…"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-900 focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onSaveUrl(urlInput.trim())}
              className="flex-1 rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white active:scale-[0.99]"
            >
              Save URL
            </button>
            <button
              type="button"
              onClick={() => onSaveUrl("")}
              className="rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-medium text-neutral-600 active:scale-95"
            >
              Skip
            </button>
          </div>
        </div>
      ) : state.status === "success" ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
          <p className="text-sm font-medium text-emerald-800">
            ✓ Published to Facebook Marketplace
          </p>
          {state.url && (
            <a
              href={state.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 block break-all text-xs text-emerald-700 underline"
            >
              {state.url}
            </a>
          )}
        </div>
      ) : state.status === "error" ? (
        <div className="space-y-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-sm font-medium text-red-800">{state.error}</p>
          {state.screenshot && (
            <p className="break-all text-[10px] text-red-600">
              Debug screenshot: {state.screenshot}
            </p>
          )}
          <button
            type="button"
            onClick={onPublish}
            className="rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 active:scale-95"
          >
            Retry
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPublish}
          className="w-full rounded-xl bg-[#1877F2] px-4 py-3.5 text-base font-semibold text-white transition active:scale-[0.99]"
        >
          Publish to Facebook Marketplace
        </button>
      )}
    </div>
  );
}

type UnifiedComp = Comp & { source: "OU" | "FB" | "EB" };

function CompsTab({
  comps,
  combinedStats,
  soldStats,
  title,
}: {
  comps: CompResponse;
  combinedStats: CombinedStats | null;
  soldStats: SoldStats | null;
  title: string;
}) {
  const offerupListings: UnifiedComp[] =
    comps && !comps.offerup.error
      ? comps.offerup.listings.map((c) => ({ ...c, source: "OU" }))
      : [];
  const fbListings: UnifiedComp[] =
    comps && !comps.facebook.error
      ? comps.facebook.listings.map((c) => ({ ...c, source: "FB" }))
      : [];
  const ebayListings: UnifiedComp[] =
    comps && !comps.ebay.error
      ? comps.ebay.listings.map((c) => ({ ...c, source: "EB" }))
      : [];

  const askingListings = [...offerupListings, ...fbListings].sort(
    (a, b) => a.price - b.price,
  );
  const soldListings = [...ebayListings].sort((a, b) => a.price - b.price);

  const hasAnyComps = !!combinedStats || !!soldStats;

  if (!hasAnyComps) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-neutral-200 bg-neutral-100 p-4 text-center">
          <p className="text-sm italic text-neutral-500">
            No comps found for this item.
          </p>
          {comps?.facebook.error === "session_expired" && (
            <p className="mt-1 text-xs text-neutral-500">
              FB session expired — re-run{" "}
              <code className="text-neutral-700">scripts/fb-login.ts</code>.
            </p>
          )}
        </div>
        <ManualSearchRow title={title} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-neutral-200 bg-neutral-100 p-4">
        <dl className="space-y-2">
          {combinedStats && (
            <div className="flex items-baseline justify-between rounded-lg bg-white px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
                Typical asking
              </dt>
              <dd className="text-lg font-semibold text-neutral-900">
                ${combinedStats.median}
              </dd>
            </div>
          )}
          {soldStats && (
            <div className="flex items-baseline justify-between rounded-lg bg-white px-3 py-2">
              <dt className="text-[10px] uppercase tracking-wide text-emerald-700">
                Recently sold
              </dt>
              <dd className="text-lg font-semibold text-emerald-700">
                ${soldStats.median}
              </dd>
            </div>
          )}
        </dl>
        <p className="mt-3 text-xs text-neutral-500">
          {combinedStats
            ? `${offerupListings.length + fbListings.length} asking`
            : "0 asking"}{" "}
          · {soldStats ? `${soldStats.count} sold` : "0 sold"}
        </p>
      </div>

      {askingListings.length > 0 && (
        <ul className="space-y-2">
          {askingListings.slice(0, 6).map((c) => (
            <CompCard key={`${c.source}-${c.url}`} comp={c} />
          ))}
        </ul>
      )}

      {soldListings.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
            Sold prices
          </h3>
          <ul className="space-y-2">
            {soldListings.slice(0, 6).map((c) => (
              <CompCard key={`${c.source}-${c.url}`} comp={c} />
            ))}
          </ul>
        </section>
      )}

      <ManualSearchRow title={title} />
    </div>
  );
}

function CompCard({ comp }: { comp: UnifiedComp }) {
  const badgeClasses =
    comp.source === "OU"
      ? "bg-amber-100 text-amber-800"
      : comp.source === "FB"
        ? "bg-blue-100 text-blue-800"
        : "bg-emerald-100 text-emerald-800";

  return (
    <li>
      <a
        href={comp.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 transition active:scale-[0.99]"
      >
        {comp.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={comp.imageUrl}
            alt=""
            className="h-12 w-12 shrink-0 rounded-md object-cover"
          />
        ) : (
          <div className="h-12 w-12 shrink-0 rounded-md bg-neutral-200" />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${badgeClasses}`}
            >
              {comp.source}
            </span>
            <p className="truncate text-sm font-medium text-neutral-800">
              {comp.title}
            </p>
          </div>
          <p className="mt-0.5 truncate text-xs text-neutral-500">
            {comp.distance}
          </p>
        </div>
        <div className="shrink-0 text-sm font-semibold text-neutral-900">
          ${comp.price}
        </div>
      </a>
    </li>
  );
}

function ManualSearchRow({ title }: { title: string }) {
  const q = encodeURIComponent(title);
  const links = [
    { label: "OfferUp", href: `https://offerup.com/search?q=${q}` },
    {
      label: "FB Marketplace",
      href: `https://www.facebook.com/marketplace/search/?query=${q}`,
    },
    {
      label: "eBay",
      href: `https://www.ebay.com/sch/i.html?_nkw=${q}&_sop=12`,
    },
  ];
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-3">
      <p className="text-xs uppercase tracking-wide text-neutral-500">
        Search manually
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {links.map((l) => (
          <a
            key={l.label}
            href={l.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium text-neutral-700 active:scale-95"
          >
            {l.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function NotesTab({ listing }: { listing: Listing }) {
  const item = listing.identified_item;
  return (
    <div className="space-y-4">
      <NotesSection label="Price reasoning">
        <p className="text-sm text-neutral-700">
          {listing.price_reasoning || (
            <span className="italic text-neutral-500">No reasoning provided.</span>
          )}
        </p>
      </NotesSection>

      <NotesSection label="Seller tips">
        <p className="text-sm text-neutral-700">
          {listing.notes_for_seller || (
            <span className="italic text-neutral-500">No tips provided.</span>
          )}
        </p>
      </NotesSection>

      <NotesSection label="Confidence">
        <p className="text-sm font-medium capitalize text-neutral-700">
          {listing.confidence}
        </p>
      </NotesSection>

      <NotesSection label="Identified item">
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
              Brand
            </dt>
            <dd className="mt-0.5 text-neutral-800">
              {item.brand || (
                <span className="italic text-neutral-400">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
              Model
            </dt>
            <dd className="mt-0.5 text-neutral-800">
              {item.model || (
                <span className="italic text-neutral-400">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wide text-neutral-500">
              Category
            </dt>
            <dd className="mt-0.5 text-neutral-800">
              {item.category_guess || (
                <span className="italic text-neutral-400">—</span>
              )}
            </dd>
          </div>
        </dl>
      </NotesSection>
    </div>
  );
}

function PriceHealth({
  price,
  p25,
  p75,
}: {
  price: number | null;
  p25: number;
  p75: number;
}) {
  const maxVisible = Math.max(p75 * 1.6, p25 + 1);
  const greenPct = (Math.min(p25, maxVisible) / maxVisible) * 100;
  const yellowPct = ((Math.min(p75, maxVisible) - p25) / maxVisible) * 100;

  const hasPrice = price !== null && price > 0;
  const markerPct = hasPrice
    ? Math.min(100, Math.max(0, (price / maxVisible) * 100))
    : null;

  let label: string | null = null;
  if (hasPrice) {
    if (price < p25) label = "Below market. Should sell quickly.";
    else if (price <= p75) label = "Fair price. In line with similar listings.";
    else label = "Above market. May take longer to sell.";
  }

  return (
    <div className="mt-3 space-y-1.5">
      <div className="relative h-3">
        <div className="absolute inset-0 overflow-hidden rounded-full bg-neutral-200">
          <div
            className="absolute inset-y-0 left-0 bg-emerald-300"
            style={{ width: `${greenPct}%` }}
          />
          <div
            className="absolute inset-y-0 bg-amber-300"
            style={{ left: `${greenPct}%`, width: `${yellowPct}%` }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-red-300"
            style={{ left: `${greenPct + yellowPct}%` }}
          />
        </div>
        {markerPct !== null && (
          <div
            className="absolute top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-neutral-900 shadow"
            style={{ left: `${markerPct}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      {label && <p className="text-xs text-neutral-600">{label}</p>}
    </div>
  );
}

function NotesSection({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedAsc[base + 1];
  return next !== undefined
    ? sortedAsc[base] + rest * (next - sortedAsc[base])
    : sortedAsc[base];
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <label className="text-sm font-medium text-neutral-800">{label}</label>
        {hint && <span className="text-xs">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function CopyButton({
  label,
  copied,
  onClick,
  primary,
}: {
  label: string;
  copied: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  const base = primary
    ? "bg-neutral-900 text-white"
    : "border border-neutral-300 bg-white text-neutral-800";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-lg px-4 py-3 text-base font-medium active:scale-[0.99] ${base}`}
    >
      {copied ? "Copied!" : label}
    </button>
  );
}
