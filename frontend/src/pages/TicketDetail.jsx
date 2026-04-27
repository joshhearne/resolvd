import React, { useEffect, useState, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { useAuth } from "../context/AuthContext";
import {
  formatDateTime,
  computePriority,
  priorityClass,
  INTERNAL_STATUSES,
  COASTAL_STATUSES,
  IMPACT_LABELS,
  URGENCY_LABELS,
} from "../utils/helpers";
import {
  useStatuses,
  nextAllowedStatusIds,
  statusByName,
  suggestedExternalForInternal,
} from "../context/StatusesContext";
import PriorityBadge from "../components/PriorityBadge";
import StatusBadge from "../components/StatusBadge";
import ConfirmDialog from "../components/ConfirmDialog";

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name, mime) {
  const ext = (name || "").split(".").pop().toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext))
    return "🖼️";
  if (["pdf"].includes(ext)) return "📄";
  if (["html", "htm"].includes(ext)) return "🌐";
  if (["txt", "log", "md", "csv"].includes(ext)) return "📝";
  if (["zip", "gz", "tar", "7z", "rar"].includes(ext)) return "🗜️";
  if (
    [
      "js",
      "ts",
      "jsx",
      "tsx",
      "json",
      "yml",
      "yaml",
      "py",
      "rb",
      "sh",
      "sql",
    ].includes(ext)
  )
    return "💾";
  if ((mime || "").startsWith("image/")) return "🖼️";
  return "📎";
}

function CommentActionDropdown({ disabled, onPostAndClose, onPostAndReopen }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className="btn-secondary btn btn-sm disabled:opacity-50 flex items-center gap-1"
      >
        Post &amp; …
        <svg
          className="w-3 h-3"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M19 9l-7 7-7-7"
          />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-44 bg-surface rounded-md shadow-lg border border-border z-20 py-1">
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onPostAndClose();
            }}
            className="w-full text-left px-4 py-2 text-sm text-fg hover:bg-surface-2"
          >
            Post &amp; Close
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onPostAndReopen();
            }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40 dark:bg-red-950/40"
          >
            Post &amp; Reopen
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-fg-dim mb-1">
        {label}
      </dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const statusCfg = useStatuses();
  const isAdmin = ["Admin", "Manager"].includes(user?.role);
  const isSubmitter = user?.role === "Submitter";
  const canEdit = isAdmin || isSubmitter;

  const [ticket, setTicket] = useState(null);
  const [comments, setComments] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  const [commentFiles, setCommentFiles] = useState([]);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [shareWithVendor, setShareWithVendor] = useState(false);
  const [showMuted, setShowMuted] = useState(false);
  const [activeTab, setActiveTab] = useState("comments");
  const [vendorContacts, setVendorContacts] = useState([]);
  const [allContacts, setAllContacts] = useState([]);
  const [addContactId, setAddContactId] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [followers, setFollowers] = useState([]);
  const [followLoading, setFollowLoading] = useState(false);

  // Inline edit state
  const [editing, setEditing] = useState({});
  const [editValues, setEditValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [blockingSearch, setBlockingSearch] = useState("");
  const [blockingResults, setBlockingResults] = useState([]);

  const loadTicket = useCallback(() => {
    return Promise.all([
      api.get(`/api/tickets/${id}`),
      api.get(`/api/tickets/${id}/comments`),
    ]).then(([t, c]) => {
      setTicket(t);
      setComments(c);
    });
  }, [id]);

  useEffect(() => {
    Promise.all([
      loadTicket(),
      api.get(`/api/tickets/${id}/audit`).catch(() => []),
      api.get(`/api/tickets/${id}/attachments`).catch(() => []),
      api.get(`/api/tickets/${id}/followers`).catch(() => []),
      api.get(`/api/tickets/${id}/contacts`).catch(() => []),
    ])
      .then(([, audit, atts, fols, vcs]) => {
        setAuditLog(audit);
        setAttachments(atts);
        setFollowers(fols);
        setVendorContacts(vcs);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id, loadTicket]);

  // Lazy-load every active contact for the project (only when admin/manager
  // is on the page) so the "Add contact to ticket" picker has options.
  useEffect(() => {
    if (!isAdmin || !ticket?.project_id) return;
    let cancelled = false;
    (async () => {
      try {
        const companies = await api.get(`/api/companies?project_id=${ticket.project_id}`);
        const all = [];
        for (const co of companies) {
          const cs = await api.get(`/api/companies/${co.id}/contacts`);
          for (const c of cs) all.push({ ...c, company_name: co.name });
        }
        if (!cancelled) setAllContacts(all);
      } catch { /* silent — feature degrades to "no picker" */ }
    })();
    return () => { cancelled = true; };
  }, [isAdmin, ticket?.project_id]);

  async function reloadContactsList() {
    try { setVendorContacts(await api.get(`/api/tickets/${id}/contacts`)); } catch {}
  }
  async function attachContact() {
    if (!addContactId) return;
    try {
      await api.post(`/api/tickets/${id}/contacts`, { contact_id: Number(addContactId) });
      setAddContactId("");
      await reloadContactsList();
    } catch (e) { toast.error(e.message); }
  }
  async function detachContact(cid) {
    try {
      await api.delete(`/api/tickets/${id}/contacts/${cid}`);
      await reloadContactsList();
    } catch (e) { toast.error(e.message); }
  }
  async function toggleAutoMute() {
    try {
      const updated = await api.patch(`/api/tickets/${id}`, {
        auto_mute_vendor_replies: !ticket.auto_mute_vendor_replies,
      });
      setTicket(updated);
    } catch (e) { toast.error(e.message); }
  }
  async function setCommentMuted(commentId, value) {
    try {
      const r = await api.post(`/api/comments/${commentId}/${value ? "mute" : "unmute"}`, {});
      setComments(prev => prev.map(c => c.id === commentId ? { ...c, is_muted: r.is_muted } : c));
    } catch (e) { toast.error(e.message); }
  }

  async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach((f) => formData.append("files", f));
      const res = await fetch(`/api/tickets/${id}/attachments`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error || "Upload failed");
      }
      const inserted = await res.json();
      setAttachments((prev) => [...prev, ...inserted]);
      toast.success(
        `${inserted.length} file${inserted.length > 1 ? "s" : ""} uploaded`,
      );
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function deleteAttachment(attId) {
    try {
      await api.delete(`/api/attachments/${attId}`);
      setAttachments((prev) => prev.filter((a) => a.id !== attId));
      toast.success("Attachment deleted");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function patch(fields) {
    setSaving(true);
    try {
      const updated = await api.patch(`/api/tickets/${id}`, fields);
      setTicket(updated);
      const audit = await api.get(`/api/tickets/${id}/audit`);
      setAuditLog(audit);
      const cmts = await api.get(`/api/tickets/${id}/comments`);
      setComments(cmts);
      toast.success("Saved");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
      setEditing({});
    }
  }

  async function submitComment(e, andStatus = null) {
    if (e) e.preventDefault();
    if (!commentBody.trim() && commentFiles.length === 0) return;
    setSubmittingComment(true);
    try {
      let c = null;
      if (commentBody.trim()) {
        c = await api.post(`/api/tickets/${id}/comments`, {
          body: commentBody.trim(),
          is_external_visible: shareWithVendor,
        });
        setComments((prev) => [...prev, c]);
      }
      if (commentFiles.length > 0) {
        const fd = new FormData();
        commentFiles.forEach((f) => fd.append("files", f));
        if (c?.id) fd.append("comment_id", String(c.id));
        const res = await fetch(`/api/tickets/${id}/attachments`, {
          method: "POST",
          credentials: "include",
          body: fd,
        });
        if (!res.ok) throw new Error("Attachment upload failed");
        const newAtts = await res.json();
        setAttachments((prev) => [...prev, ...newAtts]);
      }
      setCommentBody("");
      setCommentFiles([]);
      setShareWithVendor(false);
      if (andStatus) {
        const updated = await api.patch(`/api/tickets/${id}`, {
          internal_status: andStatus,
          ...(andStatus === "Closed" ? { flagged_for_review: false } : {}),
        });
        setTicket(updated);
        const audit = await api.get(`/api/tickets/${id}/audit`);
        setAuditLog(audit);
        toast.success(`Comment posted — ticket ${andStatus.toLowerCase()}`);
      } else {
        toast.success("Comment posted");
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmittingComment(false);
    }
  }

  async function deleteTicket() {
    try {
      await api.delete(`/api/tickets/${id}`);
      toast.success("Ticket deleted");
      navigate("/tickets");
    } catch (err) {
      toast.error(err.message);
    }
    setConfirm(null);
  }

  async function searchBlocking(q) {
    if (!q || q.length < 2) {
      setBlockingResults([]);
      return;
    }
    const data = await api.get(
      `/api/tickets?sort_by=mot_ref&sort_dir=asc&limit=10`,
    );
    const filtered = data.tickets.filter(
      (t) =>
        t.id !== ticket.id &&
        (t.mot_ref.includes(q.toUpperCase()) ||
          t.title.toLowerCase().includes(q.toLowerCase())),
    );
    setBlockingResults(filtered);
  }

  if (loading)
    return <div className="text-fg-dim py-12 text-center">Loading...</div>;
  if (!ticket)
    return (
      <div className="text-fg-muted py-12 text-center">Ticket not found</div>
    );

  const liveComputed = computePriority(
    editValues.impact ?? ticket.impact,
    editValues.urgency ?? ticket.urgency,
  );

  const isFollowing = followers.some((f) => f.id === user?.id);

  async function toggleFollow() {
    setFollowLoading(true);
    try {
      if (isFollowing) {
        await fetch(`/api/tickets/${id}/follow`, {
          method: "DELETE",
          credentials: "include",
        });
        setFollowers((prev) => prev.filter((f) => f.id !== user.id));
        toast.success("Unfollowed");
      } else {
        await fetch(`/api/tickets/${id}/follow`, {
          method: "POST",
          credentials: "include",
        });
        setFollowers((prev) => [
          ...prev,
          { id: user.id, display_name: user.displayName, email: user.email },
        ]);
        toast.success("Following — you'll get email updates");
      }
    } catch {
      toast.error("Failed to update follow status");
    } finally {
      setFollowLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono text-sm font-semibold text-fg-muted">
              {ticket.mot_ref}
            </span>
            <PriorityBadge
              priority={ticket.effective_priority}
              override={ticket.priority_override}
              computed={ticket.computed_priority}
            />
            <StatusBadge status={ticket.internal_status} />
            {ticket.flagged_for_review ? (
              <span className="text-xs font-semibold text-purple-700 dark:text-purple-300 bg-purple-100 dark:bg-purple-950/40 px-2 py-0.5 rounded-full">
                ★ Flagged for Review
              </span>
            ) : null}
          </div>
          <h1 className="text-xl font-semibold text-fg mt-2">{ticket.title}</h1>
          <p className="text-xs text-fg-dim mt-1">
            Submitted by {ticket.submitted_by_name} ·{" "}
            {formatDateTime(ticket.created_at)}
            {ticket.assigned_to_name &&
              ` · Assigned: ${ticket.assigned_to_name}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={toggleFollow}
            disabled={followLoading}
            title={
              followers.length
                ? `${followers.map((f) => f.display_name).join(", ")} following`
                : "No followers yet"
            }
            className={`btn btn-sm flex items-center gap-1.5 ${isFollowing ? "bg-brand/10 border border-brand/40 text-brand hover:bg-red-50 dark:hover:bg-red-950/40 dark:bg-red-950/40 hover:border-red-300 dark:border-red-900/50 hover:text-red-600 dark:text-red-400" : "btn-secondary"}`}
          >
            <svg
              className="w-3.5 h-3.5"
              fill={isFollowing ? "currentColor" : "none"}
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
              />
            </svg>
            {isFollowing ? "Following" : "Follow"}
            {followers.length > 0 && (
              <span className="ml-0.5 text-xs opacity-70">
                · {followers.length}
              </span>
            )}
          </button>
          {isAdmin && (
            <button
              onClick={() => setConfirm("merge")}
              className="btn-secondary btn btn-sm whitespace-nowrap"
              title="Merge this ticket into another (closes this one, reassigns comments/attachments/etc.)"
            >
              Merge…
            </button>
          )}
          {isAdmin && (
            <button
              onClick={() => setConfirm("delete")}
              className="btn-danger btn btn-sm whitespace-nowrap"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Vendor contacts strip (only when ticket has attached contacts or admin can attach) */}
      {(vendorContacts.length > 0 || (isAdmin && allContacts.length > 0)) && (
        <div className="bg-surface border border-border rounded-lg p-3 flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-fg-dim">Vendor contacts</span>
          {vendorContacts.map(c => (
            <span key={c.id}
              className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full bg-surface-2 border border-border">
              <strong className="text-fg">{c.name || c.email}</strong>
              {c.company_name && <span className="text-fg-dim">· {c.company_name}</span>}
              {isAdmin && (
                <button onClick={() => detachContact(c.id)}
                  className="text-fg-dim hover:text-red-500 ml-1" title="Detach">×</button>
              )}
            </span>
          ))}
          {isAdmin && (
            <>
              <select value={addContactId}
                onChange={(e) => setAddContactId(e.target.value)}
                className="bg-surface-2 border border-border rounded px-2 py-1 text-xs">
                <option value="">+ Attach contact…</option>
                {allContacts
                  .filter(c => !vendorContacts.some(v => v.id === c.id))
                  .map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name || c.email} {c.company_name ? `(${c.company_name})` : ""}
                    </option>
                  ))}
              </select>
              {addContactId && (
                <button onClick={attachContact}
                  className="text-xs bg-brand text-white rounded px-2 py-1">Attach</button>
              )}
              <label className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted">
                <input type="checkbox" checked={!!ticket.auto_mute_vendor_replies}
                  onChange={toggleAutoMute} />
                Auto-mute vendor replies
              </label>
            </>
          )}
        </div>
      )}

      {/* Awaiting Input banner */}
      {ticket.blocker_type === "mot_input" && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border-2 border-amber-400 dark:border-amber-900/50 rounded-lg px-4 py-3 flex items-start gap-3">
          <span className="text-amber-500 text-xl mt-0.5">⚠</span>
          <div>
            <div className="font-semibold text-amber-800 dark:text-amber-300">
              Awaiting Team Input
            </div>
            <div className="text-sm text-amber-700 dark:text-amber-300 mt-0.5">
              {ticket.mot_blocker_note ||
                "Action required before the external partner can proceed."}
            </div>
          </div>
        </div>
      )}

      {/* Pending Review banner */}
      {ticket.flagged_for_review &&
        ticket.internal_status === "Pending Review" && (
          <div className="bg-purple-50 dark:bg-purple-950/40 border-2 border-purple-400 dark:border-purple-900/50 rounded-lg px-4 py-3">
            <div className="font-semibold text-purple-800 dark:text-purple-300 mb-2">
              Pending Review — External partner marked this Resolved
            </div>
            <p className="text-sm text-purple-700 dark:text-purple-300 mb-3">
              Verify the fix, then close or reopen this ticket.
            </p>
            {isAdmin && (
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    patch({
                      internal_status: "Closed",
                      flagged_for_review: false,
                    })
                  }
                  className="btn-primary btn btn-sm"
                >
                  Close Ticket
                </button>
                <button
                  onClick={() =>
                    patch({
                      internal_status: "Reopened",
                      flagged_for_review: false,
                    })
                  }
                  className="btn-danger btn btn-sm"
                >
                  Reopen
                </button>
              </div>
            )}
          </div>
        )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: main details */}
        <div className="lg:col-span-2 space-y-4">
          {/* Description */}
          <div className="bg-surface rounded-lg border border-border shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-fg">Description</h2>
              {canEdit && !editing.description && (
                <button
                  onClick={() => {
                    setEditing({ description: true });
                    setEditValues({ description: ticket.description || "" });
                  }}
                  className="text-xs text-brand hover:underline"
                >
                  Edit
                </button>
              )}
            </div>
            {editing.description ? (
              <div className="space-y-2">
                <textarea
                  value={editValues.description}
                  onChange={(e) =>
                    setEditValues((v) => ({
                      ...v,
                      description: e.target.value,
                    }))
                  }
                  rows={5}
                  className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
                />
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      patch({ description: editValues.description })
                    }
                    disabled={saving}
                    className="btn-primary btn btn-sm"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditing({})}
                    className="btn-secondary btn btn-sm"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-fg whitespace-pre-wrap">
                {ticket.description || (
                  <span className="text-fg-dim">No description</span>
                )}
              </p>
            )}
          </div>

          {/* Comments + Audit + Attachments tabs */}
          <div className="bg-surface rounded-lg border border-border shadow-sm">
            <div className="flex border-b border-border">
              <button
                onClick={() => setActiveTab("comments")}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === "comments" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
              >
                Comments ({comments.length})
              </button>
              <button
                onClick={() => setActiveTab("attachments")}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === "attachments" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
              >
                Attachments{" "}
                {attachments.length > 0 && `(${attachments.length})`}
              </button>
              <button
                onClick={() => setActiveTab("audit")}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === "audit" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
              >
                Audit Log
              </button>
            </div>

            {activeTab === "comments" && (
              <div className="p-4 space-y-4">
                {comments.length === 0 && (
                  <p className="text-sm text-fg-dim text-center py-4">
                    No comments yet
                  </p>
                )}
                {(() => {
                  const visible = comments.filter(c => !c.is_muted);
                  const muted   = comments.filter(c =>  c.is_muted);
                  const renderComment = (c) => (
                    <div
                      key={c.id}
                      className={`rounded-lg p-3 ${c.is_system ? "bg-brand/10 border border-brand/30" : c.is_muted ? "bg-surface-2 border border-dashed border-border opacity-90" : "bg-surface-2"}`}
                    >
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="text-xs font-semibold text-fg-muted flex items-center gap-1.5">
                          {c.is_system ? "🤖 System" : (c.vendor_contact_id ? `↩ ${c.user_name || "Vendor"}` : c.user_name)}
                          {c.is_external_visible && !c.vendor_contact_id && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-brand/15 text-brand uppercase">to vendor</span>
                          )}
                          {c.vendor_contact_id && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-amber-500/15 text-amber-700 uppercase">from vendor</span>
                          )}
                          {c.is_muted && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-surface text-fg-dim uppercase">muted</span>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          {isAdmin && !c.is_system && (
                            <button onClick={() => setCommentMuted(c.id, !c.is_muted)}
                              className="text-[11px] text-fg-dim hover:text-fg">
                              {c.is_muted ? "Unmute" : "Mute"}
                            </button>
                          )}
                          <span className="text-xs text-fg-dim">{formatDateTime(c.created_at)}</span>
                        </span>
                      </div>
                      <p className="text-sm text-fg whitespace-pre-wrap">{c.body}</p>
                      {attachments.filter((a) => a.comment_id === c.id).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {attachments.filter((a) => a.comment_id === c.id).map((a) => (
                            <a key={a.id} href={`/api/attachments/${a.id}`}
                              className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-surface border border-border hover:border-border-strong hover:bg-surface-2 text-fg-muted hover:text-fg transition-colors">
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                  d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 10-5.656-5.656L4.586 11.172a6 6 0 108.486 8.486L19.07 13.7" />
                              </svg>
                              <span className="truncate max-w-[180px]">{a.original_name}</span>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                  return (
                    <>
                      {visible.map(renderComment)}
                      {muted.length > 0 && (
                        <div className="border border-dashed border-border rounded-lg">
                          <button onClick={() => setShowMuted(s => !s)}
                            className="w-full flex items-center justify-between px-3 py-2 text-xs text-fg-muted hover:text-fg">
                            <span>{muted.length} muted vendor {muted.length === 1 ? "reply" : "replies"} {showMuted ? "(hide)" : "(show)"}</span>
                            <span>{showMuted ? "▾" : "▸"}</span>
                          </button>
                          {showMuted && (
                            <div className="p-3 space-y-3 border-t border-dashed border-border bg-surface/40">
                              {muted.map(renderComment)}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()}
                {canEdit && (
                  <form
                    onSubmit={submitComment}
                    className="space-y-2 pt-2 border-t border-border"
                  >
                    <textarea
                      value={commentBody}
                      onChange={(e) => setCommentBody(e.target.value)}
                      rows={3}
                      className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
                      placeholder="Add a comment..."
                    />
                    {isAdmin && vendorContacts.length > 0 && (
                      <label className="flex items-center gap-2 text-xs text-fg-muted">
                        <input type="checkbox" checked={shareWithVendor}
                          onChange={(e) => setShareWithVendor(e.target.checked)} />
                        Share with vendor — sends this comment to the {vendorContacts.length} attached contact{vendorContacts.length === 1 ? "" : "s"} via email
                      </label>
                    )}
                    {commentFiles.length > 0 && (
                      <ul className="divide-y divide-border border border-border rounded-md">
                        {commentFiles.map((f, i) => (
                          <li
                            key={i}
                            className="flex items-center justify-between px-3 py-1.5 text-xs"
                          >
                            <span className="truncate text-fg">{f.name}</span>
                            <span className="flex items-center gap-3 flex-shrink-0">
                              <span className="text-fg-dim">
                                {(f.size / 1024).toFixed(0)} KB
                              </span>
                              <button
                                type="button"
                                onClick={() =>
                                  setCommentFiles((prev) =>
                                    prev.filter((_, idx) => idx !== i),
                                  )
                                }
                                className="text-fg-dim hover:text-red-500 transition-colors"
                              >
                                Remove
                              </button>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="submit"
                        disabled={
                          submittingComment ||
                          (!commentBody.trim() && commentFiles.length === 0)
                        }
                        className="btn-primary btn btn-sm disabled:opacity-50"
                      >
                        {submittingComment ? "Posting..." : "Post"}
                      </button>
                      <label className="btn-ghost btn btn-sm cursor-pointer">
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 10-5.656-5.656L4.586 11.172a6 6 0 108.486 8.486L19.07 13.7"
                          />
                        </svg>
                        Attach
                        <input
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            if (files.length)
                              setCommentFiles((prev) => [...prev, ...files]);
                            e.target.value = "";
                          }}
                        />
                      </label>
                      {isAdmin && (
                        <CommentActionDropdown
                          disabled={
                            submittingComment ||
                            (!commentBody.trim() && commentFiles.length === 0)
                          }
                          onPostAndClose={() => submitComment(null, "Closed")}
                          onPostAndReopen={() =>
                            submitComment(null, "Reopened")
                          }
                        />
                      )}
                    </div>
                  </form>
                )}
              </div>
            )}

            {activeTab === "attachments" && (
              <div className="p-4 space-y-4">
                {/* Drop zone */}
                {canEdit && (
                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOver(false);
                      uploadFiles(e.dataTransfer.files);
                    }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                      dragOver
                        ? "border-brand/50 bg-brand/10"
                        : "border-border-strong hover:border-border-strong"
                    }`}
                  >
                    <p className="text-sm text-fg-muted mb-2">
                      {uploading ? "Uploading…" : "Drag & drop files here, or"}
                    </p>
                    <label
                      className={`btn-secondary btn btn-sm cursor-pointer ${uploading ? "opacity-50 pointer-events-none" : ""}`}
                    >
                      Browse files
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          uploadFiles(e.target.files);
                          e.target.value = "";
                        }}
                      />
                    </label>
                    <p className="text-xs text-fg-dim mt-2">
                      Any file type · 50 MB max per file
                    </p>
                  </div>
                )}

                {/* List */}
                {attachments.length === 0 ? (
                  <p className="text-sm text-fg-dim text-center py-4">
                    No attachments yet
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {attachments.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 py-2.5">
                        <span className="text-xl">
                          {fileIcon(a.original_name, a.mimetype)}
                        </span>
                        <div className="flex-1 min-w-0">
                          <a
                            href={`/api/attachments/${a.id}`}
                            className="text-sm font-medium text-brand hover:underline truncate block"
                            download={a.original_name}
                          >
                            {a.original_name}
                          </a>
                          <span className="text-xs text-fg-dim">
                            {formatBytes(a.size)} ·{" "}
                            {a.uploaded_by_name || "Unknown"} ·{" "}
                            {formatDateTime(a.created_at)}
                          </span>
                        </div>
                        {(["Admin", "Manager"].includes(user?.role) ||
                          a.user_id === user?.id) && (
                          <button
                            onClick={() => deleteAttachment(a.id)}
                            className="text-xs text-fg-dim hover:text-red-500 dark:text-red-400 transition-colors flex-shrink-0"
                          >
                            Delete
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {activeTab === "audit" && (
              <div className="divide-y divide-border">
                {auditLog.length === 0 && (
                  <p className="text-sm text-fg-dim text-center py-6">
                    No audit entries
                  </p>
                )}
                {auditLog.map((a) => (
                  <div key={a.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm">
                        <span className="font-medium text-fg">
                          {a.action.replace(/_/g, " ")}
                        </span>
                        {a.old_value && (
                          <span className="text-fg-dim"> {a.old_value}</span>
                        )}
                        {a.new_value && (
                          <span className="text-fg-muted">
                            {" "}
                            → {a.new_value}
                          </span>
                        )}
                        {a.note && (
                          <span className="text-fg-dim ml-1">({a.note})</span>
                        )}
                      </div>
                      <span className="text-xs text-fg-dim whitespace-nowrap">
                        {formatDateTime(a.created_at)}
                      </span>
                    </div>
                    <div className="text-xs text-fg-dim mt-0.5">
                      {a.user_name || "System"}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: metadata panel */}
        <div className="space-y-4">
          {/* Priority */}
          <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-semibold text-fg">Priority</h2>
            <dl className="space-y-3">
              <Field label="Impact">
                {editing.impact ? (
                  <select
                    value={editValues.impact}
                    onChange={(e) =>
                      setEditValues((v) => ({
                        ...v,
                        impact: Number(e.target.value),
                      }))
                    }
                    className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 w-full"
                  >
                    {[1, 2, 3].map((v) => (
                      <option key={v} value={v}>
                        {IMPACT_LABELS[v]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-fg">
                      {IMPACT_LABELS[ticket.impact]}
                    </span>
                    {canEdit && (
                      <button
                        onClick={() => {
                          setEditing({ impact: true, urgency: true });
                          setEditValues({
                            impact: ticket.impact,
                            urgency: ticket.urgency,
                          });
                        }}
                        className="text-xs text-brand hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                )}
              </Field>
              <Field label="Urgency">
                {editing.urgency ? (
                  <select
                    value={editValues.urgency}
                    onChange={(e) =>
                      setEditValues((v) => ({
                        ...v,
                        urgency: Number(e.target.value),
                      }))
                    }
                    className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 w-full"
                  >
                    {[1, 2, 3].map((v) => (
                      <option key={v} value={v}>
                        {URGENCY_LABELS[v]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm text-fg">
                    {URGENCY_LABELS[ticket.urgency]}
                  </span>
                )}
              </Field>
              {(editing.impact || editing.urgency) && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-fg-muted">Preview:</span>
                  <PriorityBadge priority={liveComputed} />
                  <button
                    onClick={() =>
                      patch({
                        impact: editValues.impact,
                        urgency: editValues.urgency,
                      })
                    }
                    disabled={saving}
                    className="btn-primary btn btn-sm ml-auto"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setEditing({})}
                    className="btn-secondary btn btn-sm"
                  >
                    ×
                  </button>
                </div>
              )}
              <Field label="Computed Priority">
                <PriorityBadge priority={ticket.computed_priority} />
              </Field>
              {isAdmin && (
                <Field label="Priority Override">
                  {editing.priority_override ? (
                    <div className="flex gap-2 items-center">
                      <select
                        value={editValues.priority_override ?? ""}
                        onChange={(e) =>
                          setEditValues((v) => ({
                            ...v,
                            priority_override:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                          }))
                        }
                        className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                      >
                        <option value="">No override</option>
                        {[1, 2, 3, 4, 5].map((p) => (
                          <option key={p} value={p}>
                            P{p}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() =>
                          patch({
                            priority_override:
                              editValues.priority_override ?? null,
                          })
                        }
                        disabled={saving}
                        className="btn-primary btn btn-sm"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditing({})}
                        className="btn-secondary btn btn-sm"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      {ticket.priority_override ? (
                        <PriorityBadge
                          priority={ticket.priority_override}
                          override={ticket.priority_override}
                          computed={ticket.computed_priority}
                        />
                      ) : (
                        <span className="text-sm text-fg-dim">None</span>
                      )}
                      <button
                        onClick={() => {
                          setEditing({ priority_override: true });
                          setEditValues({
                            priority_override: ticket.priority_override,
                          });
                        }}
                        className="text-xs text-brand hover:underline"
                      >
                        Edit
                      </button>
                    </div>
                  )}
                </Field>
              )}
              <Field label="Effective Priority">
                <PriorityBadge
                  priority={ticket.effective_priority}
                  override={ticket.priority_override}
                  computed={ticket.computed_priority}
                />
              </Field>
            </dl>
          </div>

          {/* Status */}
          <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-semibold text-fg">Status</h2>
            <dl className="space-y-3">
              <Field label="Internal Status">
                {isAdmin && editing.internal_status ? (
                  <div className="flex gap-2">
                    {(() => {
                      const cur = statusByName(
                        statusCfg.internal,
                        ticket.internal_status,
                      );
                      const allowedIds = cur
                        ? new Set(
                            nextAllowedStatusIds(statusCfg.transitions, cur.id),
                          )
                        : null;
                      const opts = statusCfg.internal.length
                        ? statusCfg.internal.map((s) => s.name)
                        : INTERNAL_STATUSES;
                      const labelFor = (name) => {
                        if (!cur || !allowedIds) return name;
                        const def = statusByName(statusCfg.internal, name);
                        if (def && def.id === cur.id) return name;
                        return def && allowedIds.has(def.id)
                          ? `→ ${name}`
                          : name;
                      };
                      return (
                        <select
                          value={editValues.internal_status}
                          onChange={(e) =>
                            setEditValues((v) => ({
                              ...v,
                              internal_status: e.target.value,
                            }))
                          }
                          className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 flex-1"
                        >
                          {opts.map((s) => (
                            <option key={s} value={s}>
                              {labelFor(s)}
                            </option>
                          ))}
                        </select>
                      );
                    })()}
                    <button
                      onClick={() =>
                        patch({ internal_status: editValues.internal_status })
                      }
                      disabled={saving}
                      className="btn-primary btn btn-sm"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setEditing({})}
                      className="btn-secondary btn btn-sm"
                    >
                      ×
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <StatusBadge status={ticket.internal_status} />
                    {isAdmin && (
                      <button
                        onClick={() => {
                          setEditing({ internal_status: true });
                          setEditValues({
                            internal_status: ticket.internal_status,
                          });
                        }}
                        className="text-xs text-brand hover:underline"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                )}
              </Field>
            </dl>
          </div>

          {/* External */}
          {ticket.project_has_external_vendor === true && (
            <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
              <h2 className="text-sm font-semibold text-fg">External Vendor</h2>
              <dl className="space-y-3">
                <Field label="External Status">
                  {isAdmin && editing.coastal_status ? (
                    <div className="space-y-2">
                      {(() => {
                        const opts = statusCfg.external.length
                          ? statusCfg.external.map((s) => s.name)
                          : COASTAL_STATUSES;
                        const cur = statusByName(
                          statusCfg.external,
                          ticket.coastal_status,
                        );
                        const allowedIds = cur
                          ? new Set(
                              nextAllowedStatusIds(
                                statusCfg.transitions,
                                cur.id,
                              ),
                            )
                          : null;
                        const labelFor = (name) => {
                          if (!cur || !allowedIds) return name;
                          const def = statusByName(statusCfg.external, name);
                          if (def && def.id === cur.id) return name;
                          return def && allowedIds.has(def.id)
                            ? `→ ${name}`
                            : name;
                        };
                        return (
                          <select
                            value={editValues.coastal_status}
                            onChange={(e) =>
                              setEditValues((v) => ({
                                ...v,
                                coastal_status: e.target.value,
                              }))
                            }
                            className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 w-full"
                          >
                            {opts.map((s) => (
                              <option key={s} value={s}>
                                {labelFor(s)}
                              </option>
                            ))}
                          </select>
                        );
                      })()}
                      {(() => {
                        const internalCur = statusByName(
                          statusCfg.internal,
                          ticket.internal_status,
                        );
                        if (!internalCur) return null;
                        const sugg = suggestedExternalForInternal(
                          statusCfg.mappings,
                          internalCur.id,
                        );
                        if (!sugg.length) return null;
                        const names = sugg
                          .map(
                            (m) =>
                              statusCfg.external.find(
                                (s) => s.id === m.external_status_id,
                              )?.name,
                          )
                          .filter(Boolean);
                        if (!names.length) return null;
                        return (
                          <p className="text-xs text-fg-muted">
                            Suggested for {ticket.internal_status}:{" "}
                            {names.join(", ")}
                          </p>
                        );
                      })()}
                      <div className="flex gap-2">
                        <button
                          onClick={() =>
                            patch({ coastal_status: editValues.coastal_status })
                          }
                          disabled={saving}
                          className="btn-primary btn btn-sm"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => setEditing({})}
                          className="btn-secondary btn btn-sm"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-fg">
                        {ticket.coastal_status}
                      </span>
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setEditing({ coastal_status: true });
                            setEditValues({
                              coastal_status: ticket.coastal_status,
                            });
                          }}
                          className="text-xs text-brand hover:underline"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  )}
                </Field>
                <Field label="External Ticket Ref">
                  {isAdmin && editing.external_ticket_ref ? (
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={editValues.external_ticket_ref || ""}
                        onChange={(e) =>
                          setEditValues((v) => ({
                            ...v,
                            external_ticket_ref: e.target.value,
                          }))
                        }
                        className="border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40 flex-1"
                      />
                      <button
                        onClick={() =>
                          patch({
                            external_ticket_ref: editValues.external_ticket_ref,
                          })
                        }
                        disabled={saving}
                        className="btn-primary btn btn-sm"
                      >
                        Save
                      </button>
                      <button
                        onClick={() => setEditing({})}
                        className="btn-secondary btn btn-sm"
                      >
                        ×
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-fg">
                        {ticket.external_ticket_ref || (
                          <span className="text-fg-dim">—</span>
                        )}
                      </span>
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setEditing({ external_ticket_ref: true });
                            setEditValues({
                              external_ticket_ref:
                                ticket.external_ticket_ref || "",
                            });
                          }}
                          className="text-xs text-brand hover:underline"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  )}
                </Field>
                {ticket.coastal_updated_at && (
                  <Field label="External Updated">
                    <span className="text-xs text-fg-muted">
                      {formatDateTime(ticket.coastal_updated_at)}
                    </span>
                  </Field>
                )}
              </dl>
            </div>
          )}

          {/* Blocker */}
          {isAdmin && (
            <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-fg">Blocker</h2>
                {!editing.blocker && ticket.blocker_type && (
                  <button
                    onClick={() => patch({ blocker_type: null })}
                    className="text-xs text-red-500 dark:text-red-400 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
              {!editing.blocker && !ticket.blocker_type && (
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      setEditing({ blocker: "internal" });
                      setEditValues({ blocked_by_ticket: null });
                    }}
                    className="btn-secondary btn btn-sm"
                  >
                    + Internal Blocker
                  </button>
                  {ticket.project_has_external_vendor === true && (
                    <button
                      onClick={() => {
                        setEditing({ blocker: "mot_input" });
                        setEditValues({ mot_blocker_note: "" });
                      }}
                      className="btn-secondary btn btn-sm"
                    >
                      + Team Input
                    </button>
                  )}
                </div>
              )}
              {ticket.blocker_type === "internal" && !editing.blocker && (
                <div className="text-sm text-fg">
                  Blocked by:{" "}
                  <span className="font-medium text-red-700 dark:text-red-300">
                    {ticket.blocking_ticket_ref}
                  </span>{" "}
                  — {ticket.blocking_ticket_title}
                  <span
                    className={`ml-2 text-xs ${ticket.blocking_ticket_status === "Closed" ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}
                  >
                    ({ticket.blocking_ticket_status})
                  </span>
                </div>
              )}
              {ticket.blocker_type === "mot_input" && !editing.blocker && (
                <div className="text-sm text-amber-700 dark:text-amber-300">
                  {ticket.mot_blocker_note}
                </div>
              )}
              {editing.blocker === "internal" && (
                <div className="space-y-2">
                  <input
                    type="text"
                    placeholder="Search by ref or title..."
                    value={blockingSearch}
                    onChange={(e) => {
                      setBlockingSearch(e.target.value);
                      searchBlocking(e.target.value);
                    }}
                    className="w-full border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                  />
                  {blockingResults.length > 0 && (
                    <ul className="border border-border rounded-md divide-y">
                      {blockingResults.map((r) => (
                        <li key={r.id}>
                          <button
                            onClick={() => {
                              setEditValues((v) => ({
                                ...v,
                                blocked_by_ticket: r.id,
                              }));
                              setBlockingSearch(`${r.mot_ref} — ${r.title}`);
                              setBlockingResults([]);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2"
                          >
                            <span className="font-mono font-medium">
                              {r.mot_ref}
                            </span>{" "}
                            — {r.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        patch({
                          blocker_type: "internal",
                          blocked_by_ticket: editValues.blocked_by_ticket,
                        })
                      }
                      disabled={saving || !editValues.blocked_by_ticket}
                      className="btn-primary btn btn-sm disabled:opacity-50"
                    >
                      Set Blocker
                    </button>
                    <button
                      onClick={() => setEditing({})}
                      className="btn-secondary btn btn-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {editing.blocker === "mot_input" && (
                <div className="space-y-2">
                  <textarea
                    value={editValues.mot_blocker_note || ""}
                    onChange={(e) =>
                      setEditValues((v) => ({
                        ...v,
                        mot_blocker_note: e.target.value,
                      }))
                    }
                    rows={3}
                    placeholder="What needs to be provided to the external partner?"
                    className="w-full border border-border-strong rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() =>
                        patch({
                          blocker_type: "mot_input",
                          mot_blocker_note: editValues.mot_blocker_note,
                        })
                      }
                      disabled={saving}
                      className="btn-primary btn btn-sm"
                    >
                      Set Blocker
                    </button>
                    <button
                      onClick={() => setEditing({})}
                      className="btn-secondary btn btn-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete Ticket"
        message={`Permanently delete ${ticket.mot_ref}? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={deleteTicket}
        onCancel={() => setConfirm(null)}
      />
      <MergeDialog
        open={confirm === "merge"}
        loserRef={ticket.mot_ref}
        onCancel={() => setConfirm(null)}
        onConfirm={async (winnerId) => {
          try {
            const r = await api.post(`/api/tickets/${ticket.id}/merge`, { winner_id: winnerId });
            toast.success(`${r.loser_ref} merged into ${r.winner_ref}`);
            navigate(`/tickets/${winnerId}`);
          } catch (e) { toast.error(e.message); }
          finally { setConfirm(null); }
        }}
      />
    </div>
  );
}

function MergeDialog({ open, loserRef, onCancel, onConfirm }) {
  const [winnerId, setWinnerId] = React.useState("");
  React.useEffect(() => { if (!open) setWinnerId(""); }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl max-w-md w-full p-5">
        <h3 className="text-lg font-semibold text-fg mb-2">Merge ticket</h3>
        <p className="text-sm text-fg-muted mb-3">
          Merging <strong>{loserRef}</strong> into another ticket reassigns its comments,
          attachments, audit history, vendor contacts, and followers, then closes <strong>{loserRef}</strong>.
        </p>
        <p className="text-xs text-fg-muted mb-2">Tickets must be in the same project.</p>
        <input
          type="number"
          autoFocus
          value={winnerId}
          onChange={(e) => setWinnerId(e.target.value)}
          placeholder="Winner ticket id (numeric)"
          className="w-full bg-surface-2 border border-border rounded px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} className="btn-secondary btn btn-sm">Cancel</button>
          <button
            onClick={() => onConfirm(parseInt(winnerId, 10))}
            disabled={!winnerId}
            className="btn-primary btn btn-sm disabled:opacity-50"
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  );
}
