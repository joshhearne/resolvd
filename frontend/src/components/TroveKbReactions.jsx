import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Favorite star + helpful thumbs on a Trove KB article. The same rows
// the person has on kb.gomotx.com: Trove KB keys both by the reader's
// email. Renders nothing until Trove KB offers the reactions API.
export default function TroveKbReactions({ articleId, className = "" }) {
  const [r, setR] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setR(null);
    api.get(`/api/trove-kb/articles/${articleId}/reactions`).then(setR).catch(() => setR({ available: false }));
  }, [articleId]);

  if (!r?.available) return null;

  async function favorite() {
    setBusy(true);
    const on = !r.mine.favorite;
    setR((x) => ({ ...x, favorites: x.favorites + (on ? 1 : -1), mine: { ...x.mine, favorite: on } }));
    try { if (on) await api.put(`/api/trove-kb/articles/${articleId}/favorite`, {}); else await api.delete(`/api/trove-kb/articles/${articleId}/favorite`); }
    catch (e) { toast.error(e.message); setR(await api.get(`/api/trove-kb/articles/${articleId}/reactions`)); }
    finally { setBusy(false); }
  }
  async function vote(next) {
    setBusy(true);
    const prev = r.mine.vote;
    const target = prev === next ? null : next;
    setR((x) => {
      let up = x.helpful_up, down = x.helpful_down;
      if (prev === "up") up -= 1; if (prev === "down") down -= 1;
      if (target === "up") up += 1; if (target === "down") down += 1;
      const total = up + down;
      return { ...x, helpful_up: up, helpful_down: down, helpfulness: total ? Math.round((up / total) * 100) : null, mine: { ...x.mine, vote: target } };
    });
    try { if (target) await api.put(`/api/trove-kb/articles/${articleId}/vote`, { helpful: target === "up" }); else await api.delete(`/api/trove-kb/articles/${articleId}/vote`); }
    catch (e) { toast.error(e.message); setR(await api.get(`/api/trove-kb/articles/${articleId}/reactions`)); }
    finally { setBusy(false); }
  }

  const btn = "inline-flex items-center gap-1 px-2 py-1 rounded border text-xs transition-colors disabled:opacity-50";
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <button onClick={favorite} disabled={busy} aria-pressed={r.mine.favorite} title={r.mine.favorite ? "Remove from favorites" : "Add to favorites"} className={`${btn} ${r.mine.favorite ? "border-amber-400 text-amber-500 bg-amber-500/10" : "border-border text-fg-muted hover:text-fg hover:bg-surface-2"}`}>
        <svg viewBox="0 0 24 24" fill={r.mine.favorite ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" className="w-3.5 h-3.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
        {r.mine.favorite ? "Favorited" : "Favorite"}{r.favorites > 0 && <span className="font-mono text-[10px] opacity-70">{r.favorites}</span>}
      </button>
      <span className="text-xs text-fg-dim">Helpful?</span>
      <button onClick={() => vote("up")} disabled={busy} aria-pressed={r.mine.vote === "up"} title="Helpful" className={`${btn} ${r.mine.vote === "up" ? "border-emerald-400 text-emerald-600 dark:text-emerald-300 bg-emerald-500/10" : "border-border text-fg-muted hover:text-fg hover:bg-surface-2"}`}>👍 <span className="font-mono text-[10px]">{r.helpful_up}</span></button>
      <button onClick={() => vote("down")} disabled={busy} aria-pressed={r.mine.vote === "down"} title="Not helpful" className={`${btn} ${r.mine.vote === "down" ? "border-red-400 text-red-500 bg-red-500/10" : "border-border text-fg-muted hover:text-fg hover:bg-surface-2"}`}>👎 <span className="font-mono text-[10px]">{r.helpful_down}</span></button>
      {r.helpfulness != null && <span className="text-[11px] text-fg-dim">{r.helpfulness}% found this helpful</span>}
    </div>
  );
}
