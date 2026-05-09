import { useState } from "react";

// Lazy-loaded help screenshot. Falls back to a dashed placeholder when the
// image is missing (404) — useful while shots are being authored or reshot.
//
// Place PNGs under frontend/public/help/<slug>.png so they're served at
// /help/<slug>.png. Keep filenames slug-cased to match the screenshot plan
// at scripts/screenshots-help.json.
export default function HelpScreenshot({ src, alt, caption }) {
  const [errored, setErrored] = useState(false);

  if (errored || !src) {
    return (
      <div className="border-2 border-dashed border-border rounded-lg flex items-center justify-center h-32 my-3 bg-surface-2 text-fg-dim text-xs">
        [ Screenshot: {alt || "missing"} ]
      </div>
    );
  }

  return (
    <figure className="my-3">
      <img
        src={src}
        alt={alt}
        loading="lazy"
        onError={() => setErrored(true)}
        className="w-full rounded-lg border border-border bg-surface-2 shadow-sm"
      />
      {caption && (
        <figcaption className="mt-1.5 text-[11px] text-fg-muted italic text-center">
          {caption}
        </figcaption>
      )}
    </figure>
  );
}
