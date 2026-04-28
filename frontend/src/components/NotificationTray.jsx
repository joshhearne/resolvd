import React, { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../utils/api";

const POLL_MS = 30_000;

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function NotificationTray() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);
  const navigate = useNavigate();

  async function load() {
    try {
      const data = await api.get("/api/notifications");
      setItems(data.items || []);
      setUnread(data.unread || 0);
    } catch (_) {}
  }

  useEffect(() => {
    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  async function markRead(id) {
    try {
      await api.patch(`/api/notifications/${id}/read`, {});
      setItems(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n));
      setUnread(prev => Math.max(0, prev - 1));
    } catch (_) {}
  }

  async function markAllRead() {
    try {
      await api.patch("/api/notifications/read-all", {});
      setItems(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
      setUnread(0);
    } catch (_) {}
  }

  function handleAction(item) {
    if (!item.read_at) markRead(item.id);
    if (item.data?.ticket_id) {
      const state = item.data.comment_id ? { highlightComment: item.data.comment_id } : undefined;
      navigate(`/tickets/${item.data.ticket_id}`, { state });
      setOpen(false);
    } else if (item.type === "unmatched_cc" && item.data?.suggested_company_id) {
      navigate(`/companies/${item.data.suggested_company_id}`);
      setOpen(false);
    } else if (item.type === "unmatched_cc" && item.data?.project_id) {
      navigate(`/projects/${item.data.project_id}/companies`);
      setOpen(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-label="Notifications"
        className="relative p-2 rounded-md text-fg-muted hover:text-fg hover:bg-surface-2 transition-colors"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
        </svg>
        {unread > 0 && (
          <span className="absolute top-1 right-1 min-w-[16px] h-4 px-0.5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1 w-80 bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold text-fg">Notifications</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-[11px] text-fg-muted hover:text-fg">
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <div className="px-3 py-6 text-xs text-fg-dim text-center">No notifications</div>
            ) : items.map(item => (
              <div
                key={item.id}
                onClick={() => handleAction(item)}
                className={`px-3 py-2.5 border-b border-border last:border-0 ${!item.read_at ? "bg-brand/5" : ""} ${item.data?.ticket_id || item.type === "unmatched_cc" ? "cursor-pointer hover:bg-surface-2" : ""}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className={`text-xs font-medium leading-snug ${!item.read_at ? "text-fg" : "text-fg-muted"}`}>
                      {item.title}
                    </p>
                    {item.body && (
                      <p className="text-[11px] text-fg-dim mt-0.5 leading-snug line-clamp-2">{item.body}</p>
                    )}
                    <p className="text-[10px] text-fg-dim mt-1">{timeAgo(item.created_at)}</p>
                  </div>
                  {!item.read_at && (
                    <button
                      onClick={() => markRead(item.id)}
                      className="shrink-0 w-1.5 h-1.5 rounded-full bg-brand mt-1.5"
                      aria-label="Mark read"
                    />
                  )}
                </div>
                {item.type === "unmatched_cc" && item.data && (
                  <button
                    onClick={() => handleAction(item)}
                    className="mt-1.5 text-[11px] text-brand hover:underline font-medium"
                  >
                    {item.data.suggested_company_id
                      ? `Add to ${item.data.suggested_company_name || "company"} →`
                      : "View companies →"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
