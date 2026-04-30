import React from "react";
import { formatHybrid, formatAbsolute } from "../utils/helpers";

// Renders the hybrid timestamp string (relative <7d, absolute after) with
// a title tooltip showing the absolute value in the user's chosen
// date/time style. Inside ~7d the displayed text is relative, so the
// tooltip surfaces the actual time. Beyond cutoff hybrid == absolute and
// the tooltip is omitted (would be a duplicate).
export default function HybridTime({ dt, className }) {
  if (!dt) return <span className={className}>—</span>;
  const text = formatHybrid(dt);
  const abs = formatAbsolute(dt);
  const tip = text === abs ? undefined : abs;
  return (
    <span className={className} title={tip}>
      {text}
    </span>
  );
}
