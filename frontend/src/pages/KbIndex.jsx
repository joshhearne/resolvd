import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";

export default function KbIndex() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .get("/api/kb/projects")
      .then(setProjects)
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  }, []);

  async function toggleStar(proj) {
    const next = !proj.starred;
    setProjects((prev) => {
      const flipped = prev.map((p) => (p.id === proj.id ? { ...p, starred: next } : p));
      return [...flipped].sort((a, b) => {
        if (!!a.starred !== !!b.starred) return a.starred ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    });
    try {
      if (next) await api.put(`/api/users/me/starred-projects/${proj.id}`, {});
      else await api.delete(`/api/users/me/starred-projects/${proj.id}`);
    } catch (err) {
      toast.error(err.message || "Star toggle failed");
      setProjects((prev) => prev.map((p) => (p.id === proj.id ? { ...p, starred: !next } : p)));
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">Knowledge Base</h1>
        <p className="text-sm text-fg-muted mt-1">
          Per-project documentation. Pick a project to browse or edit its articles.
        </p>
      </header>

      {loading ? (
        <div className="text-fg-muted text-sm">Loading…</div>
      ) : projects.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface p-8 text-center">
          <p className="text-fg-muted">No projects available.</p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((p) => (
            <div key={p.id} className="relative">
              <Link
                to={`/kb/${p.id}`}
                className="block group rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-accent/40 transition-colors p-5 pr-14"
              >
                {/* pr-14 reserves space on the right for the absolute
                    star button so the title + count never tuck under
                    it on narrow cards. */}
                <div className="min-w-0">
                  <div className="text-xs font-mono text-fg-dim uppercase tracking-wider">
                    {p.prefix}
                  </div>
                  <div className="mt-1 text-base font-semibold text-fg truncate group-hover:text-accent">
                    {p.name}
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs text-fg-muted">
                  <span className="px-2 py-0.5 rounded-full font-mono bg-surface-2 text-fg-muted">
                    {p.article_count}
                  </span>
                  <span>
                    {p.article_count === 0
                      ? "No articles yet"
                      : `article${p.article_count === 1 ? "" : "s"}`}
                  </span>
                </div>
              </Link>
              <button
                type="button"
                onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleStar(p); }}
                className={`absolute top-2 right-2 p-2 rounded-md hover:bg-surface-2 transition-colors min-w-[40px] min-h-[40px] inline-flex items-center justify-center ${p.starred ? "text-amber-400" : "text-fg-dim hover:text-fg-muted"}`}
                title={p.starred ? "Unstar" : "Star"}
                aria-label={p.starred ? "Unstar" : "Star"}
              >
                <svg viewBox="0 0 24 24" fill={p.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6" className="w-5 h-5">
                  <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
