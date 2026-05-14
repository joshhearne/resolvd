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
            <Link
              key={p.id}
              to={`/kb/${p.id}`}
              className="group rounded-lg border border-border bg-surface hover:bg-surface-2 hover:border-accent/40 transition-colors p-5"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-mono text-fg-dim uppercase tracking-wider">
                    {p.prefix}
                  </div>
                  <div className="mt-1 text-base font-semibold text-fg truncate group-hover:text-accent">
                    {p.name}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-full text-xs font-mono bg-surface-2 text-fg-muted">
                  {p.article_count}
                </span>
              </div>
              <div className="mt-3 text-xs text-fg-muted">
                {p.article_count === 0
                  ? "No articles yet"
                  : `${p.article_count} article${p.article_count === 1 ? "" : "s"}`}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
