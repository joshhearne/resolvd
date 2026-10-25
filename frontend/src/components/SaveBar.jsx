import { useCallback, useState } from "react";

// Shared save bar for admin settings pages. Pinned to the bottom of the
// screen so Save is always in reach on long pages and on phones, and it
// says whether there's anything to save. One compact row at every width.
//
//   <SaveBar dirty={dirty} saving={saving} onSave={save} onDiscard={discard} />
//
// `savedHint` (optional) explains what the bar doesn't cover, e.g. lists
// on the same page that save as they're edited. Shown on wider screens.

export default function SaveBar({
  dirty,
  saving = false,
  onSave,
  onDiscard,
  saveLabel = "Save changes",
  savedHint,
}) {
  return (
    <div
      className={`sticky bottom-0 z-10 -mx-4 px-4 sm:mx-0 sm:rounded-t-lg sm:border-x py-3 border-t flex items-center gap-2 sm:gap-3 backdrop-blur ${
        dirty ? "bg-surface/95 border-brand/40" : "bg-bg/90 border-border"
      }`}
      style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
    >
      <span className={`flex-1 min-w-0 text-xs leading-tight ${dirty ? "text-amber-600 dark:text-amber-400 font-medium" : "text-fg-muted"}`}>
        {dirty ? "Unsaved changes" : (
          <>All saved{savedHint && <span className="hidden sm:inline"> — {savedHint}</span>}</>
        )}
      </span>
      {dirty && onDiscard && (
        <button type="button" onClick={onDiscard} disabled={saving} className="btn btn-sm btn-secondary shrink-0">
          Discard
        </button>
      )}
      <button type="button" disabled={!dirty || saving} onClick={onSave} className="btn btn-sm btn-primary shrink-0">
        {saving ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}

// Tracks a form against its last-saved copy. `markSaved(value)` resets the
// baseline after a load or save; `dirty` is true while they differ.
export function useSavedBaseline(current) {
  const [baseline, setBaseline] = useState(null);
  const markSaved = useCallback((value) => setBaseline(JSON.stringify(value)), []);
  const dirty = baseline != null && current != null && JSON.stringify(current) !== baseline;
  const savedValue = baseline == null ? null : JSON.parse(baseline);
  return { dirty, markSaved, savedValue };
}
