import React, { useEffect, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { Link, useParams, useNavigate, useLocation } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { pushRecentTicket } from "../utils/recentTickets";
import { useAuth } from "../context/AuthContext";
import {
  computePriority,
  priorityClass,
  IMPACT_LABELS,
  URGENCY_LABELS,
} from "../utils/helpers";
import HybridTime from "../components/HybridTime";
import SlaTimer from "../components/SlaTimer";
import AiUsageBadge from "../components/AiUsageBadge";
import MentionTextarea from "../components/MentionTextarea";
import {
  useStatuses,
  nextAllowedStatusIds,
  statusByName,
  suggestedExternalForInternal,
  DEFAULT_INTERNAL_STATUSES,
  DEFAULT_EXTERNAL_STATUSES,
} from "../context/StatusesContext";
import PriorityBadge from "../components/PriorityBadge";
import StatusBadge from "../components/StatusBadge";
import MarkdownEditor from "../components/MarkdownEditor";
import MarkdownContent from "../components/MarkdownContent";
import ConfirmDialog from "../components/ConfirmDialog";
import PhoneticPopover from "../components/PhoneticPopover";
import MergePicker from "../components/MergePicker";
import { vendorPillStyle, VENDOR_PILL_CLASSES } from "../utils/vendorColor";
import PageShell from "../components/PageShell";
import CannedPicker from "../components/CannedPicker";

// External ticket refs may hold multiple vendor IDs separated by comma
// or semicolon (e.g. "VND-1234, VND-5678" or "VND-1234;VND-5678").
// Each token gets its own phonetic-readback popover; original separators
// are preserved between tokens.
function ExternalRefList({ value }) {
  const parts = String(value).split(/([,;])/);
  return (
    <>
      {parts.map((p, i) => {
        if (p === "," || p === ";") return <span key={i}>{p} </span>;
        const trimmed = p.trim();
        if (!trimmed) return null;
        return <PhoneticPopover key={i} value={trimmed}>{trimmed}</PhoneticPopover>;
      })}
    </>
  );
}

// Pick the "primary advance" target for the next-step button. Skips
// blocker statuses (Awaiting Input, On Hold) and the reopened tag.
// From a blocker/reopened state, resume to the in_progress-tagged
// status. Returns null when current is terminal or unknown.
function nextInternalStatus(current, list) {
  if (!current) return null;
  if (current.is_terminal) return null;
  const SIDE_TAGS = new Set([
    "reopened",
    "on_hold",
    "awaiting_input",
  ]);
  if (current.is_blocker || SIDE_TAGS.has(current.semantic_tag)) {
    return list.find((s) => s.semantic_tag === "in_progress") || null;
  }
  const sorted = [...list].sort((a, b) => a.sort_order - b.sort_order);
  const idx = sorted.findIndex((s) => s.id === current.id);
  if (idx < 0) return null;
  for (let i = idx + 1; i < sorted.length; i++) {
    const s = sorted[i];
    if (s.is_blocker) continue;
    if (SIDE_TAGS.has(s.semantic_tag)) continue;
    return s;
  }
  return null;
}

function FollowupControl({ ticketId, followupAt, onChange }) {
  const [days, setDays] = React.useState(3);
  const [busy, setBusy] = React.useState(false);

  async function schedule() {
    setBusy(true);
    try {
      await api.post(`/api/tickets/${ticketId}/followup`, { days });
      toast.success(`Follow-up set for ${days} day${days === 1 ? "" : "s"}`);
      onChange?.();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    try {
      await api.delete(`/api/tickets/${ticketId}/followup`);
      toast.success("Follow-up cancelled");
      onChange?.();
    } catch (e) {
      toast.error(e.message || "Failed");
    } finally {
      setBusy(false);
    }
  }

  if (followupAt) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs bg-surface-2 border border-border rounded px-2 py-1.5">
        <span className="text-fg">
          Follow-up: <HybridTime dt={followupAt} />
        </span>
        <button
          onClick={cancel}
          disabled={busy}
          className="text-red-600 dark:text-red-400 hover:underline"
        >
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        min="1"
        max="90"
        value={days}
        onChange={(e) => setDays(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        className="w-16 border border-border-strong rounded-md px-2 py-1 text-sm"
      />
      <span className="text-xs text-fg-muted">day{days === 1 ? "" : "s"}</span>
      <button
        onClick={schedule}
        disabled={busy}
        className="btn-secondary btn btn-sm flex-1"
      >
        Schedule follow-up
      </button>
    </div>
  );
}

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

function isImageAttachment(a) {
  if (!a) return false;
  const mime = (a.mimetype || "").toLowerCase();
  if (mime.startsWith("image/")) return true;
  const ext = (a.original_name || "").split(".").pop().toLowerCase();
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(ext);
}

function Lightbox({ attachment, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  if (!attachment) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-[200] bg-black/85 flex items-center justify-center p-6 cursor-zoom-out"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={attachment.original_name || "Image preview"}
    >
      <img
        src={`/api/attachments/${attachment.id}/view`}
        alt={attachment.original_name || ""}
        className="max-h-full max-w-full object-contain shadow-2xl cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
      <div className="absolute top-4 left-4 right-16 truncate text-xs text-white/80">
        {attachment.original_name}
      </div>
      <a
        href={`/api/attachments/${attachment.id}`}
        download={attachment.original_name}
        onClick={(e) => e.stopPropagation()}
        className="absolute bottom-4 right-4 text-xs px-3 py-1.5 rounded bg-white/10 text-white/90 hover:bg-white/20"
      >
        Download
      </a>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close preview"
        className="absolute top-3 right-4 text-white/80 hover:text-white text-3xl leading-none"
      >
        ×
      </button>
    </div>,
    document.body,
  );
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
  const location = useLocation();
  const { user } = useAuth();
  const [highlightedComment, setHighlightedComment] = useState(
    location.state?.highlightComment ?? null
  );
  const statusCfg = useStatuses();
  // "isAdmin" here = elevated ticket handler. Tech is in this group
  // (internal IT staff). Variable name kept for blast-radius reasons.
  const isAdmin = ["Admin", "Manager", "Tech"].includes(user?.role);
  const isSubmitter = user?.role === "Submitter";
  const canEdit = isAdmin || isSubmitter;

  const [ticket, setTicket] = useState(null);
  const [comments, setComments] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState("");
  // Captured when the AI modal applies a rewrite to commentBody. Sent
  // up with the next comment POST + cleared. One-shot — discarded if
  // the user edits the body further before submitting.
  const [commentAiLogId, setCommentAiLogId] = useState(null);
  const [commentFiles, setCommentFiles] = useState([]);
  const [submittingComment, setSubmittingComment] = useState(false);
  const [shareWithVendor, setShareWithVendor] = useState(false);
  const [sendAsModal, setSendAsModal] = useState(null); // { action: 'comment'|'notify', andStatus, mode: 'has-submitter'|'no-submitter' }
  const [projectMembers, setProjectMembers] = useState([]);
  const [restrictFollowers, setRestrictFollowers] = useState(true);
  const [sendAsPick, setSendAsPick] = useState("");
  const [submitAsPick, setSubmitAsPick] = useState("");
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
  const [allUsers, setAllUsers] = useState([]);
  const [editingSubmitter, setEditingSubmitter] = useState(false);
  const [submitterDraft, setSubmitterDraft] = useState("");
  const [showFollowerMgr, setShowFollowerMgr] = useState(false);
  const [addFollowerId, setAddFollowerId] = useState("");
  const [showMobileActions, setShowMobileActions] = useState(false);

  // Internal notes are open to handlers — global Admin/Manager/Tech OR
  // project members with a handler role_override / is_agent. Server
  // gate is authoritative; canHandleNotes is set when the notes GET
  // returns 2xx so the tab and composer only render for users the
  // server lets through.
  const [notes, setNotes] = useState([]);
  const [canHandleNotes, setCanHandleNotes] = useState(false);
  const [lightboxAttachment, setLightboxAttachment] = useState(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [commentFilter, setCommentFilter] = useState("all"); // all | vendor | internal

  // Auto-surface a high-confidence KB suggestion on ticket open. The
  // Resolution tab also lists suggestions but only after the user clicks
  // in — banner gets eyeballs without an extra click. Dismissal is
  // session-scoped per ticket so it doesn't re-pop on every refresh.
  const KB_HINT_THRESHOLD = 0.45;
  const [topKbHit, setTopKbHit] = useState(null);
  const [kbHintDismissed, setKbHintDismissed] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    api.get("/api/users").then(setAllUsers).catch(() => setAllUsers([]));
  }, [isAdmin]);

  useEffect(() => {
    if (!ticket?.id) return;
    // Don't bother if the ticket already has linked KB articles or a
    // resolution summary — operator either already knows or already
    // handled it.
    if (ticket.resolution_summary) return;
    const dismissKey = `kb_hint_dismissed_${ticket.id}`;
    if (sessionStorage.getItem(dismissKey)) { setKbHintDismissed(true); return; }
    let cancelled = false;
    (async () => {
      try {
        const [s, links] = await Promise.all([
          api.get(`/api/kb/tickets/${ticket.id}/suggestions?limit=1`),
          api.get(`/api/kb/tickets/${ticket.id}/links`).catch(() => []),
        ]);
        if (cancelled) return;
        if (links && links.length > 0) return;
        const top = Array.isArray(s) && s[0];
        if (top && Number(top.sim) >= KB_HINT_THRESHOLD) setTopKbHit(top);
      } catch { /* silent — banner is a nice-to-have */ }
    })();
    return () => { cancelled = true; };
  }, [ticket?.id, ticket?.resolution_summary]);

  function dismissKbHint() {
    if (ticket?.id) sessionStorage.setItem(`kb_hint_dismissed_${ticket.id}`, '1');
    setKbHintDismissed(true);
  }
  async function linkSuggestedKb() {
    if (!topKbHit) return;
    try {
      await api.post(`/api/kb/tickets/${ticket.id}/links`, {
        article_id: topKbHit.article_id,
        kind: 'suggested_accepted',
      });
      toast.success('Article linked to ticket');
      setTopKbHit(null);
    } catch (e) { toast.error(e.message); }
  }

  const [project, setProject] = useState(null);
  useEffect(() => {
    if (!isAdmin || !ticket?.project_id) return;
    api.get(`/api/projects/${ticket.project_id}`)
      .then((p) => {
        setProject(p);
        setProjectMembers(p?.members || []);
        // Effective flag is computed server-side and combines per-project
        // override with the org default. Falls back to "restricted" if the
        // field is absent on older API responses.
        setRestrictFollowers(p?.effective_restrict_followers !== false);
      })
      .catch(() => setProjectMembers([]));
  }, [isAdmin, ticket?.project_id]);

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
      // Push into the TicketList "Recently opened" rail. Done here so
      // direct deep-links + ticket-detail nav populate history, not
      // just clicks from the list page.
      pushRecentTicket({ id: t.id, ref: t.internal_ref, title: t.title });
    });
  }, [id]);

  useEffect(() => {
    Promise.all([
      loadTicket(),
      api.get(`/api/tickets/${id}/audit`).catch(() => []),
      api.get(`/api/tickets/${id}/attachments`).catch(() => []),
      api.get(`/api/tickets/${id}/followers`).catch(() => []),
      api.get(`/api/tickets/${id}/contacts`).catch(() => []),
      // Notes route is gated server-side. Attempt unconditionally — a
      // 403 just means the user isn't a handler on this project; we
      // hide the tab in that case. { granted, notes } shape lets the
      // .then() distinguish "no access" from "access but empty".
      api.get(`/api/tickets/${id}/notes`)
        .then((n) => ({ granted: true, notes: Array.isArray(n) ? n : [] }))
        .catch(() => ({ granted: false, notes: [] })),
    ])
      .then(([, audit, atts, fols, vcs, nts]) => {
        setAuditLog(audit);
        setAttachments(atts);
        setFollowers(fols);
        setVendorContacts(vcs);
        setNotes(nts.notes);
        setCanHandleNotes(nts.granted);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [id, loadTicket]);

  async function addNote() {
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    try {
      const n = await api.post(`/api/tickets/${id}/notes`, { body });
      setNotes((prev) => [...prev, n]);
      setNoteDraft("");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingNote(false);
    }
  }

  async function deleteNote(noteId) {
    try {
      await api.delete(`/api/tickets/${id}/notes/${noteId}`);
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    } catch (e) { toast.error(e.message); }
  }

  // Mode-switch helpers — let an agent flip a draft from one composer
  // to the other without copy/paste. Comment->Note posts immediately
  // (notes have no extra knobs). Note->Comment transfers text into the
  // comment composer and jumps to that tab so the agent can still
  // choose vendor-share / canned response / etc. before posting.
  async function commentDraftToNote() {
    const body = commentBody.trim();
    if (!body) return;
    if (commentFiles.length > 0) {
      toast.error("Remove attached files before saving as a note (notes don't support attachments).");
      return;
    }
    setSavingNote(true);
    try {
      const n = await api.post(`/api/tickets/${id}/notes`, { body });
      setNotes((prev) => [...prev, n]);
      setCommentBody("");
      setCommentAiLogId(null);
      setActiveTab("notes");
      toast.success("Saved as internal note");
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSavingNote(false);
    }
  }

  function noteDraftToComment() {
    const body = noteDraft.trim();
    if (!body) return;
    setCommentBody((cur) => cur && cur.trim() ? `${cur}\n\n${body}` : body);
    setNoteDraft("");
    setActiveTab("comments");
  }

  // Scroll to and flash a highlighted comment (e.g. from a mention notification).
  useEffect(() => {
    if (!highlightedComment || comments.length === 0) return;
    const el = document.getElementById(`comment-${highlightedComment}`);
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("ring-2", "ring-brand", "!bg-brand/15");
    const t = setTimeout(() => {
      el.classList.remove("ring-2", "ring-brand", "!bg-brand/15");
      setHighlightedComment(null);
    }, 2500);
    return () => clearTimeout(t);
  }, [highlightedComment, comments]);

  // Lazy-load every active contact for the project (only when admin/manager
  // is on the page) so the "Add contact to ticket" picker has options.
  // Global Escape handler — close whichever overlay is on top. A native
  // <select> dropdown inside the followers popover consumes Esc itself
  // (browser-native), so the user gets the natural "1-2 punch": first
  // Esc collapses the user-picker dropdown, second Esc lands here and
  // closes the popover. Same hook covers the mobile actions sheet and
  // the confirm dialog so every transient overlay obeys Esc.
  useEffect(() => {
    function onKey(e) {
      if (e.key !== "Escape") return;
      if (showFollowerMgr) { setShowFollowerMgr(false); return; }
      if (showMobileActions) { setShowMobileActions(false); return; }
      if (confirm) { setConfirm(null); return; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showFollowerMgr, showMobileActions, confirm]);

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
  async function notifyVendor(send_as = null) {
    // Intercept: admin/manager firing vendor email needs to pick a sender
    // identity. Two prompt variants:
    //   - has-submitter:  current user differs from submitter → me / submitter
    //   - no-submitter:   ticket has no submitter (e.g. imported) → pick anyone,
    //                     optionally backfill ticket.submitted_by
    if (send_as === null && isAdmin) {
      if (ticket?.submitted_by && user?.id !== ticket.submitted_by) {
        setSendAsModal({ action: 'notify', mode: 'has-submitter' });
        return;
      }
      if (!ticket?.submitted_by) {
        setSendAsPick("");
        setSubmitAsPick("");
        setSendAsModal({ action: 'notify', mode: 'no-submitter' });
        return;
      }
    }
    try {
      const r = await api.post(`/api/tickets/${id}/notify-vendor`, send_as ? { send_as } : {});
      toast.success(r.sent > 0 ? `Vendor notified (${r.sent} recipient${r.sent !== 1 ? "s" : ""})` : "No active contacts to notify");
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function deleteComment(commentId) {
    if (!window.confirm("Delete this comment? This cannot be undone.")) return;
    try {
      await api.delete(`/api/comments/${commentId}`);
      setComments(prev => prev.filter(c => c.id !== commentId));
    } catch (err) {
      toast.error(err.message);
    }
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

  function sendAsPromptMode() {
    if (!isAdmin || !shareWithVendor) return null;
    if (ticket?.submitted_by && user?.id !== ticket.submitted_by) return 'has-submitter';
    if (!ticket?.submitted_by) return 'no-submitter';
    return null;
  }

  async function submitComment(e, andStatus = null, send_as = null) {
    if (e) e.preventDefault();
    if (!commentBody.trim() && commentFiles.length === 0) return;
    // Intercept: admin/manager sending vendor-visible comment needs sender choice
    if (send_as === null) {
      const mode = sendAsPromptMode();
      if (mode) {
        if (mode === 'no-submitter') {
          setSendAsPick("");
          setSubmitAsPick("");
        }
        setSendAsModal({ action: 'comment', andStatus, mode });
        return;
      }
    }
    setSubmittingComment(true);
    try {
      let c = null;
      // Defer the vendor outbound when files are queued — the comment
      // POST and the attachment POST are separate round trips, and the
      // race used to fire vendor email before files were linked. With
      // defer_vendor_email=true the comment row stashes the resolved
      // send_as actor; the attachments POST then fires sendVendorEmail
      // once the files are persisted (notify_vendor flag below).
      const hasFiles = commentFiles.length > 0;
      const deferVendorEmail = shareWithVendor && hasFiles;
      if (commentBody.trim()) {
        c = await api.post(`/api/tickets/${id}/comments`, {
          body: commentBody.trim(),
          is_external_visible: shareWithVendor,
          ...(shareWithVendor && send_as ? { send_as } : {}),
          ...(commentAiLogId ? { ai_rewrite_log_id: commentAiLogId } : {}),
          ...(deferVendorEmail ? { defer_vendor_email: true } : {}),
        });
        setComments((prev) => [...prev, c]);
      }
      if (hasFiles) {
        const fd = new FormData();
        commentFiles.forEach((f) => fd.append("files", f));
        if (c?.id) fd.append("comment_id", String(c.id));
        if (deferVendorEmail && c?.id) fd.append("notify_vendor", "true");
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
      setCommentAiLogId(null);
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
      `/api/tickets?sort_by=internal_ref&sort_dir=asc&limit=10`,
    );
    const filtered = data.tickets.filter(
      (t) =>
        t.id !== ticket.id &&
        (t.internal_ref.includes(q.toUpperCase()) ||
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

  async function addFollower(userId) {
    try {
      await api.post(`/api/tickets/${id}/followers`, { user_id: userId });
      const u = allUsers.find((x) => x.id === userId);
      if (u) {
        setFollowers((prev) =>
          prev.some((f) => f.id === u.id)
            ? prev
            : [...prev, { id: u.id, display_name: u.display_name, email: u.email }],
        );
      }
      setAddFollowerId("");
      toast.success("Follower added");
    } catch (e) {
      toast.error(e.message || "Failed");
    }
  }
  async function removeFollower(userId) {
    try {
      await api.delete(`/api/tickets/${id}/followers/${userId}`);
      setFollowers((prev) => prev.filter((f) => f.id !== userId));
      toast.success("Follower removed");
    } catch (e) {
      toast.error(e.message || "Failed");
    }
  }

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
    <PageShell variant="standard" className="space-y-6">
      {/* Breadcrumb — Tickets > [Project prefix · Name] > REF. The
          project segment only renders once the /api/projects fetch
          lands (loaded right after the ticket itself); falls back to
          just Tickets > REF if project isn't visible yet. */}
      <nav aria-label="Breadcrumb" className="text-xs text-fg-dim">
        <Link to="/tickets" className="hover:text-brand">Tickets</Link>
        {project && (
          <>
            <span className="mx-1.5">›</span>
            <Link
              to={`/tickets?project_id=${project.id}`}
              className="hover:text-brand"
              title={project.name}
            >
              {project.prefix ? <span className="font-mono">{project.prefix}</span> : null}
              {project.prefix && project.name ? <span className="ml-1">· {project.name}</span> : project.name}
            </Link>
          </>
        )}
        <span className="mx-1.5">›</span>
        <span className="font-mono text-fg">{ticket.internal_ref}</span>
      </nav>

      {topKbHit && !kbHintDismissed && (
        <div className="bg-brand/5 border border-brand/30 rounded-lg p-3 flex flex-wrap items-start gap-3">
          <div className="flex-1 min-w-[200px]">
            <div className="text-xs font-semibold text-brand uppercase tracking-wide mb-1">
              Possible KB match
            </div>
            <Link
              to={`/kb/${topKbHit.project_id}/${topKbHit.slug}`}
              className="text-sm font-medium text-fg hover:underline"
            >
              {topKbHit.title}
            </Link>
            <span className="ml-2 text-xs text-fg-dim font-mono">
              {Number(topKbHit.sim).toFixed(2)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to={`/kb/${topKbHit.project_id}/${topKbHit.slug}`}
              className="text-xs px-2 py-1 rounded border border-border text-fg hover:bg-surface-2"
            >
              View
            </Link>
            {canEdit && (
              <button
                onClick={linkSuggestedKb}
                className="text-xs px-2 py-1 rounded bg-brand text-white hover:opacity-90"
              >
                Link to ticket
              </button>
            )}
            <button
              onClick={dismissKbHint}
              className="text-xs text-fg-muted hover:text-fg px-2"
              title="Dismiss for this session"
            >
              ×
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <PhoneticPopover
              value={ticket.internal_ref}
              className="font-mono text-sm font-semibold text-fg-muted"
            >
              {ticket.internal_ref}
            </PhoneticPopover>
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
          {editing.title ? (
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <input
                type="text"
                autoFocus
                value={editValues.title ?? ""}
                onChange={(e) =>
                  setEditValues((v) => ({ ...v, title: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && editValues.title?.trim()) {
                    patch({
                      title: editValues.title.trim(),
                      ...(editValues._ai_log_id ? { ai_rewrite_log_id: editValues._ai_log_id } : {}),
                    });
                  } else if (e.key === "Escape") {
                    setEditing({});
                  }
                }}
                className="flex-1 min-w-[200px] text-xl font-semibold border border-border-strong rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              <AiRewriteButton
                value={editValues.title || ""}
                surface="ticket_subject"
                projectId={ticket?.project_id || null}
                size="xs"
                onChange={(t, meta) => {
                  setEditValues((v) => ({
                    ...v,
                    title: t,
                    ...(meta?.logId ? { _ai_log_id: meta.logId } : {}),
                  }));
                }}
              />
              <button
                onClick={() =>
                  editValues.title?.trim() &&
                  patch({
                    title: editValues.title.trim(),
                    ...(editValues._ai_log_id ? { ai_rewrite_log_id: editValues._ai_log_id } : {}),
                  })
                }
                disabled={saving || !editValues.title?.trim()}
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
          ) : (
            <h1 className="group text-xl font-semibold text-fg mt-2 flex items-center gap-2">
              {ticket.title}
              {canEdit && (
                <button
                  onClick={() => {
                    setEditing({ title: true });
                    setEditValues({ title: ticket.title });
                  }}
                  className="text-xs text-brand hover:underline opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Edit title"
                >
                  Edit
                </button>
              )}
            </h1>
          )}
          <p className="text-xs text-fg-dim mt-1">
            Submitted by{" "}
            {editingSubmitter ? (
              <span className="inline-flex items-center gap-1 align-middle">
                <select
                  value={submitterDraft}
                  onChange={(e) => setSubmitterDraft(e.target.value)}
                  className="border border-border-strong rounded px-1 py-0.5 text-xs"
                >
                  {allUsers
                    .filter((u) => u.status === "active")
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name || u.email}
                      </option>
                    ))}
                </select>
                <button
                  onClick={() => {
                    patch({ submitted_by: Number(submitterDraft) });
                    setEditingSubmitter(false);
                  }}
                  className="text-brand hover:underline"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingSubmitter(false)}
                  className="text-fg-muted hover:underline"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <>
                {ticket.submitted_by_name}
                {isAdmin && (
                  <button
                    onClick={() => {
                      setSubmitterDraft(String(ticket.submitted_by || ""));
                      setEditingSubmitter(true);
                    }}
                    className="ml-1 text-brand hover:underline"
                  >
                    (change)
                  </button>
                )}
              </>
            )}{" "}
            · <HybridTime dt={ticket.created_at} />
            {ticket.assigned_to_name &&
              ` · Assigned: ${ticket.assigned_to_name}`}
          </p>
          <div className="mt-1.5">
            <SlaTimer ticket={ticket} />
          </div>
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
            <div className="relative">
              <button
                onClick={() => setShowFollowerMgr((v) => !v)}
                className="btn-secondary btn btn-sm"
                title="Manage followers"
              >
                +
              </button>
              {showFollowerMgr && (
                <div className="absolute right-0 top-full mt-1 w-72 bg-surface rounded-md shadow-lg border border-border z-30 p-3 space-y-2">
                  <div className="text-xs font-semibold text-fg uppercase tracking-wide">
                    Followers ({followers.length})
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {followers.length === 0 && (
                      <div className="text-xs text-fg-muted italic">None</div>
                    )}
                    {followers.map((f) => (
                      <div
                        key={f.id}
                        className="flex items-center justify-between text-sm"
                      >
                        <span className="truncate">
                          {f.display_name || f.email}
                        </span>
                        <button
                          onClick={() => removeFollower(f.id)}
                          className="text-red-600 dark:text-red-400 hover:underline text-xs"
                        >
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex items-center gap-1 pt-2 border-t border-border">
                    <select
                      value={addFollowerId}
                      onChange={(e) => setAddFollowerId(e.target.value)}
                      className="flex-1 border border-border-strong rounded px-2 py-1 text-sm"
                    >
                      <option value="">Add user…</option>
                      {(() => {
                        // Admins ignore the project flag — they can add anyone.
                        // Otherwise, when restrict_followers_to_members is on,
                        // limit the list to project members.
                        const useMembers =
                          user?.role !== "Admin" && restrictFollowers;
                        const source = useMembers
                          ? projectMembers.map((m) => ({
                              id: m.user_id,
                              display_name: m.display_name,
                              email: m.email,
                              status: m.status || "active",
                            }))
                          : allUsers;
                        return source
                          .filter(
                            (u) =>
                              u.status === "active" &&
                              !followers.some((f) => f.id === u.id),
                          )
                          .map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.display_name || u.email}
                            </option>
                          ));
                      })()}
                    </select>
                    <button
                      onClick={() =>
                        addFollowerId && addFollower(Number(addFollowerId))
                      }
                      disabled={!addFollowerId}
                      className="btn-primary btn btn-sm disabled:opacity-50"
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
          {/* Desktop inline actions */}
          <div className="hidden sm:flex items-center gap-2">
            {["Admin", "Manager"].includes(user?.role) && vendorContacts.length > 0 && (
              <button
                onClick={() => notifyVendor()}
                className="btn-secondary btn btn-sm whitespace-nowrap"
                title="Send new_ticket vendor email now (includes any uploaded attachments)"
              >
                Notify Vendor
              </button>
            )}
            <button
              onClick={() => setConfirm("move")}
              className="btn-secondary btn btn-sm whitespace-nowrap"
              title="Move this ticket to a different project (re-issues ref, detaches vendor contacts)"
            >
              Move…
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
          {/* Mobile kebab menu */}
          <div className="relative sm:hidden">
            <button
              onClick={() => setShowMobileActions((v) => !v)}
              className="btn-secondary btn btn-sm"
              title="More actions"
              aria-label="More actions"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 4a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 4.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zm0 4.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z" />
              </svg>
            </button>
            {showMobileActions && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-surface rounded-md shadow-lg border border-border z-30 py-1">
                {["Admin", "Manager"].includes(user?.role) && vendorContacts.length > 0 && (
                  <button
                    onClick={() => { setShowMobileActions(false); notifyVendor(); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2"
                  >
                    Notify Vendor
                  </button>
                )}
                <button
                  onClick={() => { setShowMobileActions(false); setConfirm("move"); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2"
                >
                  Move…
                </button>
                {isAdmin && (
                  <button
                    onClick={() => { setShowMobileActions(false); setConfirm("merge"); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2"
                  >
                    Merge…
                  </button>
                )}
                {isAdmin && (
                  <button
                    onClick={() => { setShowMobileActions(false); setConfirm("delete"); }}
                    className="w-full text-left px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/40"
                  >
                    Delete
                  </button>
                )}
              </div>
            )}
          </div>
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
              {ticket.internal_blocker_note ||
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
            <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-sm font-semibold text-fg">Description</h2>
                <AiUsageBadge
                  provider={ticket.ai_provider}
                  model={ticket.ai_model}
                  inputTokens={ticket.ai_input_tokens}
                  outputTokens={ticket.ai_output_tokens}
                  tone={ticket.ai_tone}
                  verbosity={ticket.ai_verbosity}
                  eli5={ticket.ai_eli5}
                  projectContextUsed={ticket.ai_project_context_used}
                />
              </div>
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
                <MarkdownEditor
                  aiSurface="ticket_description"
                  aiProjectId={ticket?.project_id || null}
                  value={editValues.description}
                  onChange={(e) =>
                    setEditValues((v) => ({
                      ...v,
                      description: e.target.value,
                      ...(Object.prototype.hasOwnProperty.call(e.target, "_aiLogId")
                        ? { _ai_log_id: e.target._aiLogId }
                        : {}),
                    }))
                  }
                  rows={5}
                />
                <div className="flex gap-2">
                  <button
                    onClick={() =>
                      patch({
                        description: editValues.description,
                        ...(editValues._ai_log_id ? { ai_rewrite_log_id: editValues._ai_log_id } : {}),
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
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              ticket.description ? (
                <MarkdownContent>{ticket.description}</MarkdownContent>
              ) : (
                <span className="text-fg-dim text-sm">No description</span>
              )
            )}
          </div>

          {/* Comments + Attachments + Resolution + Audit tabs */}
          <div className="bg-surface rounded-lg border border-border shadow-sm">
            <div className="flex border-b border-border">
              <button
                onClick={() => setActiveTab("comments")}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === "comments" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
              >
                Comments ({comments.length})
              </button>
              {canHandleNotes && (
                <button
                  onClick={() => setActiveTab("notes")}
                  className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === "notes" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
                  title="Internal notes — hidden from Submitters and Vendors"
                >
                  Notes{notes.length > 0 && ` (${notes.length})`}
                  <span className="ml-1 text-[10px] text-fg-dim normal-case">internal</span>
                </button>
              )}
              <button
                onClick={() => setActiveTab("attachments")}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === "attachments" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
              >
                Attachments{" "}
                {attachments.length > 0 && `(${attachments.length})`}
              </button>
              <button
                onClick={() => setActiveTab("resolution")}
                className={`relative px-4 py-3 text-sm font-medium transition-colors ${activeTab === "resolution" ? "border-b-2 border-brand text-brand" : "text-fg-muted hover:text-fg"}`}
                title="Record how this was fixed and link KB articles"
              >
                Resolution
                {canEdit && !!ticket.resolved_at && !ticket.resolution_summary && (
                  <span
                    className="ml-1.5 inline-flex h-2 w-2 rounded-full bg-amber-500 animate-pulse align-middle"
                    aria-label="Fix not yet recorded"
                  />
                )}
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
                {comments.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <label className="text-fg-muted">Show:</label>
                    <select
                      value={commentFilter}
                      onChange={(e) => setCommentFilter(e.target.value)}
                      className="bg-surface-2 border border-border rounded px-2 py-1 text-xs"
                    >
                      <option value="all">All</option>
                      <option value="vendor">From vendor</option>
                      <option value="internal">From us</option>
                    </select>
                  </div>
                )}
                {comments.length === 0 && (
                  <p className="text-sm text-fg-dim text-center py-4">
                    No comments yet
                  </p>
                )}
                {(() => {
                  const matchesFilter = (c) =>
                    commentFilter === "all"
                      ? true
                      : commentFilter === "vendor"
                      ? !!c.vendor_contact_id
                      : !c.vendor_contact_id;
                  const visible = comments.filter(c => !c.is_muted && matchesFilter(c));
                  const muted   = comments.filter(c =>  c.is_muted && matchesFilter(c));
                  const renderComment = (c) => (
                    <div
                      key={c.id}
                      id={`comment-${c.id}`}
                      className={`rounded-lg p-3 transition-all duration-500 ${c.is_system ? "bg-brand/10 border border-brand/30" : c.is_muted ? "bg-surface-2 border border-dashed border-border opacity-90" : "bg-surface-2"}`}
                    >
                      <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                        <span className="text-xs font-semibold text-fg-muted flex items-center gap-1.5 flex-wrap">
                          {c.is_system ? "🤖 System" : (c.vendor_contact_id ? `↩ ${c.vendor_contact_name || c.vendor_company_name || "Vendor"}` : c.user_name)}
                          {c.is_external_visible && !c.vendor_contact_id && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-brand/15 text-brand uppercase">to vendor</span>
                          )}
                          {c.vendor_contact_id && (
                            <span
                              className={`text-[10px] px-1 py-0.5 rounded uppercase ${VENDOR_PILL_CLASSES}`}
                              style={vendorPillStyle(c.vendor_company_id ?? c.vendor_contact_id)}
                              title={c.vendor_company_name ? `Reply from ${c.vendor_company_name}` : "Reply from vendor"}
                            >
                              from {c.vendor_company_name || "vendor"}
                            </span>
                          )}
                          {c.is_muted && (
                            <span className="text-[10px] px-1 py-0.5 rounded bg-surface text-fg-dim uppercase">muted</span>
                          )}
                        </span>
                        <span className="flex items-center gap-2 flex-wrap">
                          <AiUsageBadge
                            provider={c.ai_provider}
                            model={c.ai_model}
                            inputTokens={c.ai_input_tokens}
                            outputTokens={c.ai_output_tokens}
                            tone={c.ai_tone}
                            verbosity={c.ai_verbosity}
                            eli5={c.ai_eli5}
                            projectContextUsed={c.ai_project_context_used}
                          />
                          {isAdmin && !c.is_system && (
                            <>
                              <button onClick={() => setCommentMuted(c.id, !c.is_muted)}
                                className="text-[11px] text-fg-dim hover:text-fg">
                                {c.is_muted ? "Unmute" : "Mute"}
                              </button>
                              <button onClick={() => deleteComment(c.id)}
                                className="text-[11px] text-fg-dim hover:text-red-500 transition-colors">
                                Delete
                              </button>
                            </>
                          )}
                          <HybridTime dt={c.created_at} className="text-xs text-fg-dim" />
                        </span>
                      </div>
                      <MarkdownContent>{c.body}</MarkdownContent>
                      {attachments.filter((a) => a.comment_id === c.id).length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {attachments.filter((a) => a.comment_id === c.id).map((a) => (
                            isImageAttachment(a) ? (
                              <button
                                key={a.id}
                                type="button"
                                onClick={() => setLightboxAttachment(a)}
                                title={`${a.original_name} — click to preview`}
                                className="block rounded border border-border hover:border-border-strong overflow-hidden bg-surface focus:outline-none focus:ring-2 focus:ring-brand/40"
                              >
                                <img
                                  src={`/api/attachments/${a.id}/view`}
                                  alt={a.original_name || ""}
                                  loading="lazy"
                                  className="max-h-32 max-w-[200px] object-contain bg-black/5 dark:bg-white/5"
                                />
                              </button>
                            ) : (
                              <a key={a.id} href={`/api/attachments/${a.id}`}
                                className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded bg-surface border border-border hover:border-border-strong hover:bg-surface-2 text-fg-muted hover:text-fg transition-colors">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                    d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 10-5.656-5.656L4.586 11.172a6 6 0 108.486 8.486L19.07 13.7" />
                                </svg>
                                <span className="truncate max-w-[180px]">{a.original_name}</span>
                              </a>
                            )
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
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-fg-muted">New comment</span>
                      <CannedPicker
                        ticketId={ticket.id}
                        projectId={ticket.project_id}
                        onInsert={(text) =>
                          setCommentBody((cur) =>
                            cur && cur.trim() ? `${cur}\n\n${text}` : text
                          )
                        }
                      />
                    </div>
                    <MarkdownEditor
                      aiSurface={shareWithVendor ? "comment_vendor" : "comment_internal"}
                      aiProjectId={ticket?.project_id || null}
                      value={commentBody}
                      onChange={(e) => {
                        setCommentBody(e.target.value);
                        // _aiLogId rides on the synthetic event emitted by the
                        // AI modal. Capture it; clear when present=null (means
                        // user edited manually) but keep a previously-set id
                        // until next submit.
                        if (Object.prototype.hasOwnProperty.call(e.target, "_aiLogId")) {
                          setCommentAiLogId(e.target._aiLogId);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (
                          user?.preferences?.ctrl_enter_to_post !== false &&
                          (e.ctrlKey || e.metaKey) &&
                          e.key === "Enter" &&
                          !submittingComment &&
                          (commentBody.trim() || commentFiles.length > 0)
                        ) {
                          e.preventDefault();
                          submitComment(e);
                        }
                      }}
                      rows={3}
                      placeholder="Add a comment... (Ctrl+Enter to post)"
                      mentionProjectId={ticket?.project_id}
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
                          onPostAndClose={() => {
                            if (
                              user?.preferences?.confirm_before_close &&
                              !window.confirm(
                                `Post this comment and close ${ticket.internal_ref}?`,
                              )
                            ) {
                              return;
                            }
                            submitComment(null, "Closed");
                          }}
                          onPostAndReopen={() =>
                            submitComment(null, "Reopened")
                          }
                        />
                      )}
                      {canHandleNotes && (
                        <button
                          type="button"
                          onClick={commentDraftToNote}
                          disabled={savingNote || !commentBody.trim()}
                          title="Save what you've typed as an internal note instead"
                          className="ml-auto text-xs text-fg-muted hover:text-amber-600 disabled:opacity-40"
                        >
                          {savingNote ? "Saving…" : "Save as internal note →"}
                        </button>
                      )}
                    </div>
                  </form>
                )}
              </div>
            )}

            {activeTab === "notes" && canHandleNotes && (
              <div className="p-4 space-y-3">
                <div className="text-xs text-fg-muted bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-2 py-1.5">
                  Internal notes are visible only to handlers (Admin / Manager / Tech).
                  Submitters and vendors never see this content.
                </div>
                {notes.length === 0 && (
                  <p className="text-sm text-fg-dim text-center py-4">
                    No internal notes yet.
                  </p>
                )}
                {notes.map((n) => (
                  <div key={n.id} className="rounded-lg p-3 bg-amber-50/40 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-800/60">
                    <div className="flex items-center justify-between mb-1 gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-fg-muted">
                        {n.user_name || "Unknown"}
                        <span className="ml-1.5 text-[10px] px-1 py-0.5 rounded bg-amber-200/70 dark:bg-amber-800/60 text-amber-900 dark:text-amber-100 uppercase">internal</span>
                      </span>
                      <span className="flex items-center gap-2">
                        {(n.user_id === user?.id || user?.role === "Admin") && (
                          <button
                            onClick={() => deleteNote(n.id)}
                            className="text-[11px] text-fg-dim hover:text-red-500"
                          >Delete</button>
                        )}
                        <HybridTime dt={n.created_at} className="text-xs text-fg-dim" />
                      </span>
                    </div>
                    <MarkdownContent>{n.body}</MarkdownContent>
                  </div>
                ))}
                <div className="border-t border-border pt-3 space-y-2">
                  <MentionTextarea
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    projectId={ticket?.project_id}
                    agentsOnly={true}
                    placeholder="Add an internal note (markdown ok, @mention project agents). Not visible to submitters or vendors."
                    rows={3}
                    className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-sm"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={addNote}
                      disabled={savingNote || !noteDraft.trim()}
                      className="text-sm px-3 py-1 bg-brand text-white rounded disabled:opacity-50"
                    >
                      {savingNote ? "Saving…" : "Add note"}
                    </button>
                    <button
                      type="button"
                      onClick={noteDraftToComment}
                      disabled={!noteDraft.trim()}
                      title="Move this draft into the Comment composer instead"
                      className="ml-auto text-xs text-fg-muted hover:text-brand disabled:opacity-40"
                    >
                      Send as comment instead →
                    </button>
                  </div>
                </div>
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
                        {isImageAttachment(a) ? (
                          <button
                            type="button"
                            onClick={() => setLightboxAttachment(a)}
                            title="Click to preview"
                            className="block w-14 h-14 rounded border border-border hover:border-border-strong overflow-hidden bg-surface-2 flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-brand/40"
                          >
                            <img
                              src={`/api/attachments/${a.id}/view`}
                              alt={a.original_name || ""}
                              loading="lazy"
                              className="w-full h-full object-cover"
                            />
                          </button>
                        ) : (
                          <span className="text-xl w-14 text-center flex-shrink-0">
                            {fileIcon(a.original_name, a.mimetype)}
                          </span>
                        )}
                        <div className="flex-1 min-w-0">
                          {isImageAttachment(a) ? (
                            <button
                              type="button"
                              onClick={() => setLightboxAttachment(a)}
                              className="text-sm font-medium text-brand hover:underline truncate block text-left w-full"
                            >
                              {a.original_name}
                            </button>
                          ) : (
                            <a
                              href={`/api/attachments/${a.id}`}
                              className="text-sm font-medium text-brand hover:underline truncate block"
                              download={a.original_name}
                            >
                              {a.original_name}
                            </a>
                          )}
                          <span className="text-xs text-fg-dim">
                            {formatBytes(a.size)} ·{" "}
                            {a.uploaded_by_name || "Unknown"} ·{" "}
                            <HybridTime dt={a.created_at} />
                            {isImageAttachment(a) && (
                              <>
                                {" · "}
                                <a
                                  href={`/api/attachments/${a.id}`}
                                  download={a.original_name}
                                  className="text-fg-muted hover:text-fg underline-offset-2 hover:underline"
                                >
                                  Download
                                </a>
                              </>
                            )}
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

            {activeTab === "resolution" && (
              <div className="p-4">
                <KnowledgePanel
                  ticketId={ticket.id}
                  projectId={ticket.project_id}
                  canEdit={canEdit}
                  isAdmin={isAdmin}
                  ticketResolved={!!ticket.resolved_at}
                  ticketRef={ticket.internal_ref}
                  ticketExternalStatus={ticket.external_status}
                  resolutionSummary={ticket.resolution_summary}
                  onResolutionChange={async (next) => {
                    try {
                      await api.patch(`/api/tickets/${ticket.id}`, { resolution_summary: next });
                      const refreshed = await api.get(`/api/tickets/${ticket.id}`);
                      setTicket(refreshed);
                      toast.success(next ? "Resolution saved" : "Resolution cleared");
                    } catch (e) { toast.error(e.message); }
                  }}
                />
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
                      <HybridTime dt={a.created_at} className="text-xs text-fg-dim whitespace-nowrap" />
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

          {/* Linked asset (per-project gated) */}
          {project?.allow_asset_linking && (
            <AssetLinkCard
              ticket={ticket}
              projectId={ticket.project_id}
              canEdit={canEdit}
              onLink={async (assetId) => {
                try {
                  const updated = await api.patch(`/api/tickets/${id}`, { asset_id: assetId });
                  setTicket(updated);
                  toast.success(assetId ? "Asset linked" : "Asset unlinked");
                } catch (e) {
                  toast.error(e.message);
                }
              }}
            />
          )}

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
                        : DEFAULT_INTERNAL_STATUSES;
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
                  <div className="space-y-2">
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
                    {isAdmin &&
                      (() => {
                        const cur = statusByName(
                          statusCfg.internal,
                          ticket.internal_status,
                        );
                        const next = nextInternalStatus(
                          cur,
                          statusCfg.internal,
                        );
                        if (!next) return null;
                        const blocked = !!ticket.followup_at;
                        return (
                          <button
                            onClick={() =>
                              patch({ internal_status: next.name })
                            }
                            disabled={saving || blocked}
                            title={
                              blocked
                                ? "Follow-up reminder pending — cancel it or wait for it to fire before advancing."
                                : undefined
                            }
                            className="btn-primary btn btn-sm w-full disabled:opacity-50"
                          >
                            Advance to {next.name}
                          </button>
                        );
                      })()}
                    {isAdmin &&
                      (() => {
                        const cur = statusByName(
                          statusCfg.internal,
                          ticket.internal_status,
                        );
                        if (cur?.semantic_tag !== "pending_review")
                          return null;
                        return (
                          <FollowupControl
                            ticketId={ticket.id}
                            followupAt={ticket.followup_at}
                            onChange={loadTicket}
                          />
                        );
                      })()}
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
                  {isAdmin && editing.external_status ? (
                    <div className="space-y-2">
                      {(() => {
                        const opts = statusCfg.external.length
                          ? statusCfg.external.map((s) => s.name)
                          : DEFAULT_EXTERNAL_STATUSES;
                        const cur = statusByName(
                          statusCfg.external,
                          ticket.external_status,
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
                            value={editValues.external_status}
                            onChange={(e) =>
                              setEditValues((v) => ({
                                ...v,
                                external_status: e.target.value,
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
                            patch({ external_status: editValues.external_status })
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
                        {ticket.external_status}
                      </span>
                      {isAdmin && (
                        <button
                          onClick={() => {
                            setEditing({ external_status: true });
                            setEditValues({
                              external_status: ticket.external_status,
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
                        {ticket.external_ticket_ref ? (
                          <ExternalRefList value={ticket.external_ticket_ref} />
                        ) : (
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
                {ticket.external_updated_at && (
                  <Field label="External Updated">
                    <HybridTime dt={ticket.external_updated_at} className="text-xs text-fg-muted" />
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
                        setEditValues({ internal_blocker_note: "" });
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
                  {ticket.internal_blocker_note}
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
                              setBlockingSearch(`${r.internal_ref} — ${r.title}`);
                              setBlockingResults([]);
                            }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2"
                          >
                            <span className="font-mono font-medium">
                              {r.internal_ref}
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
                    value={editValues.internal_blocker_note || ""}
                    onChange={(e) =>
                      setEditValues((v) => ({
                        ...v,
                        internal_blocker_note: e.target.value,
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
                          internal_blocker_note: editValues.internal_blocker_note,
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
        message={`Permanently delete ${ticket.internal_ref}? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={deleteTicket}
        onCancel={() => setConfirm(null)}
      />
      <MergePicker
        open={confirm === "merge"}
        anchorTicket={ticket}
        onCancel={() => setConfirm(null)}
        onConfirm={async ({ loserId, winnerId }) => {
          try {
            const r = await api.post(`/api/tickets/${loserId}/merge`, { winner_id: winnerId });
            toast.success(`${r.loser_ref} merged into ${r.winner_ref}`);
            navigate(`/tickets/${winnerId}`);
          } catch (e) { toast.error(e.message); }
          finally { setConfirm(null); }
        }}
      />
      <MoveDialog
        open={confirm === "move"}
        currentRef={ticket.internal_ref}
        currentProjectId={ticket.project_id}
        userRole={user?.role}
        onCancel={() => setConfirm(null)}
        onConfirm={async (projectId) => {
          try {
            const r = await api.post(`/api/tickets/${ticket.id}/move`, { project_id: projectId });
            toast.success(`Moved: ${r.old_ref} → ${r.new_ref}`);
            await loadTicket();
          } catch (e) { toast.error(e.message); }
          finally { setConfirm(null); }
        }}
      />

      {/* Send As modal — shown when admin/manager sends vendor email on behalf */}
      {sendAsModal && sendAsModal.mode === 'has-submitter' && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-bg border border-border rounded-xl shadow-xl p-6 w-full max-w-sm mx-4">
            <h3 className="text-sm font-semibold text-fg mb-1">Send as whom?</h3>
            <p className="text-xs text-fg-muted mb-4">
              You are not the ticket submitter. Choose which name appears on the vendor email.
            </p>
            <div className="flex flex-col gap-2">
              <button
                className="btn btn-primary btn-sm text-left"
                onClick={() => {
                  const ctx = sendAsModal;
                  setSendAsModal(null);
                  if (ctx.action === 'notify') notifyVendor('self');
                  else submitComment(null, ctx.andStatus, 'self');
                }}
              >
                Send as me — {user?.displayName || user?.email}
              </button>
              <button
                className="btn btn-ghost btn-sm text-left"
                onClick={() => {
                  const ctx = sendAsModal;
                  setSendAsModal(null);
                  if (ctx.action === 'notify') notifyVendor('submitter');
                  else submitComment(null, ctx.andStatus, 'submitter');
                }}
              >
                Send as submitter — {ticket?.submitted_by_name}
              </button>
              <button
                className="btn btn-ghost btn-sm text-fg-muted"
                onClick={() => setSendAsModal(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* No-submitter variant: pick a project member to either send-as
          (one-off identity on vendor email) or submit-as (backfill the
          ticket's submitted_by, useful for imported tickets). */}
      {sendAsModal && sendAsModal.mode === 'no-submitter' && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
          <div className="bg-bg border border-border rounded-xl shadow-xl p-6 w-full max-w-md mx-4">
            <h3 className="text-sm font-semibold text-fg mb-1">No submitter on this ticket</h3>
            <p className="text-xs text-fg-muted mb-4">
              Pick someone in the project so the vendor email isn't sent from the system address.
            </p>

            <div className="flex flex-col gap-4">
              <div>
                <label className="block text-xs font-medium text-fg mb-1">Send as</label>
                <p className="text-xs text-fg-dim mb-2">
                  Vendor email goes out under this person's name. Doesn't change the ticket.
                </p>
                <div className="flex gap-2">
                  <select
                    value={sendAsPick}
                    onChange={(e) => setSendAsPick(e.target.value)}
                    className="flex-1 border border-border-strong rounded px-2 py-1 text-sm bg-bg text-fg"
                  >
                    <option value="">— choose person —</option>
                    {projectMembers.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.display_name || m.email}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!sendAsPick}
                    onClick={() => {
                      const ctx = sendAsModal;
                      const pick = sendAsPick;
                      setSendAsModal(null);
                      if (ctx.action === 'notify') notifyVendor(pick);
                      else submitComment(null, ctx.andStatus, pick);
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <label className="block text-xs font-medium text-fg mb-1">Submit as</label>
                <p className="text-xs text-fg-dim mb-2">
                  Set this person as the ticket's original submitter, then send. Best for imported tickets.
                </p>
                <div className="flex gap-2">
                  <select
                    value={submitAsPick}
                    onChange={(e) => setSubmitAsPick(e.target.value)}
                    className="flex-1 border border-border-strong rounded px-2 py-1 text-sm bg-bg text-fg"
                  >
                    <option value="">— choose person —</option>
                    {projectMembers.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {m.display_name || m.email}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn btn-primary btn-sm"
                    disabled={!submitAsPick}
                    onClick={async () => {
                      const ctx = sendAsModal;
                      const pickId = Number(submitAsPick);
                      setSendAsModal(null);
                      try {
                        const updated = await api.patch(`/api/tickets/${id}`, { submitted_by: pickId });
                        setTicket(updated);
                      } catch (err) {
                        toast.error(err.message);
                        return;
                      }
                      if (ctx.action === 'notify') notifyVendor('submitter');
                      else submitComment(null, ctx.andStatus, 'submitter');
                    }}
                  >
                    Submit + send
                  </button>
                </div>
              </div>

              <button
                className="btn btn-ghost btn-sm text-fg-muted"
                onClick={() => setSendAsModal(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {lightboxAttachment && (
        <Lightbox
          attachment={lightboxAttachment}
          onClose={() => setLightboxAttachment(null)}
        />
      )}
    </PageShell>
  );
}

function MoveDialog({ open, currentRef, currentProjectId, userRole, onCancel, onConfirm }) {
  const [projects, setProjects] = React.useState([]);
  const [targetId, setTargetId] = React.useState("");
  const isPriv = ["Admin", "Manager"].includes(userRole);

  React.useEffect(() => {
    if (!open) { setTargetId(""); return; }
    api.get("/api/projects")
      .then((all) => setProjects(all.filter((p) => p.status === "active")))
      .catch(() => setProjects([]));
  }, [open]);

  if (!open) return null;
  const choices = projects.filter((p) => p.id !== currentProjectId);
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 px-4">
      <div className="bg-surface border border-border rounded-lg shadow-xl max-w-md w-full p-5">
        <h3 className="text-lg font-semibold text-fg mb-2">Move ticket</h3>
        <p className="text-sm text-fg-muted mb-3">
          Move <strong>{currentRef}</strong> to a different project. The ticket
          will be re-issued a new reference from the target project's counter.
          Vendor contacts will be detached (vendor scope is project-bound) —
          re-attach as needed after the move. Comments, attachments, audit
          history, and followers carry over.
        </p>
        {!isPriv && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mb-2">
            You can only move to projects you're a member of.
          </p>
        )}
        <select
          autoFocus
          value={targetId}
          onChange={(e) => setTargetId(e.target.value)}
          className="w-full border border-border-strong rounded-md px-3 py-2 text-sm mb-4"
        >
          <option value="">Select target project…</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.prefix})
            </option>
          ))}
        </select>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary btn btn-sm">
            Cancel
          </button>
          <button
            onClick={() => targetId && onConfirm(Number(targetId))}
            disabled={!targetId}
            className="btn-primary btn btn-sm disabled:opacity-50"
          >
            Move
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}


function AssetLinkCard({ ticket, projectId, canEdit, onLink }) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    if (!editing) return;
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.get(
          `/api/assets?project_id=${projectId}&q=${encodeURIComponent(q)}&limit=20`
        );
        setResults(r.items || []);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [editing, q, projectId]);

  return (
    <div className="bg-surface rounded-lg border border-border shadow-sm p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-fg">Linked asset</h2>
        {canEdit && !editing && (
          <button
            onClick={() => { setEditing(true); setQ(""); }}
            className="text-xs text-brand hover:underline"
          >
            {ticket.asset_id ? "Change" : "Link"}
          </button>
        )}
      </div>
      {!editing && (
        <div className="text-sm">
          {ticket.asset_id ? (
            <div className="flex items-center justify-between gap-2">
              <a href={`/inventory`} className="text-brand hover:underline truncate">
                {ticket.asset_hostname || `#${ticket.asset_id}`}
              </a>
              {canEdit && (
                <button
                  onClick={() => onLink(null)}
                  className="text-xs text-red-600 hover:underline"
                >
                  Unlink
                </button>
              )}
            </div>
          ) : (
            <span className="text-fg-dim italic">None</span>
          )}
        </div>
      )}
      {editing && (
        <div className="space-y-2">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="hostname, serial, org…"
            autoFocus
            className="w-full border border-border-strong rounded px-2 py-1 text-sm"
          />
          <div className="max-h-56 overflow-y-auto border border-border rounded divide-y divide-border text-xs">
            {loading ? (
              <div className="p-2 text-fg-dim">Searching…</div>
            ) : results.length === 0 ? (
              <div className="p-2 text-fg-dim italic">No matches.</div>
            ) : (
              results.map((a) => (
                <button
                  key={a.id}
                  onClick={async () => { await onLink(a.id); setEditing(false); }}
                  className="w-full text-left px-2 py-1.5 hover:bg-surface-2"
                >
                  <div className="font-medium text-fg">
                    {a.hostname || <span className="italic text-fg-dim">unnamed</span>}
                  </div>
                  <div className="text-fg-dim">
                    {a.serial ? `${a.serial} · ` : ""}{a.organization || ""}
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="flex justify-end">
            <button
              onClick={() => setEditing(false)}
              className="text-xs text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Knowledge panel — surfaces linked KB articles, top similarity-ranked
// suggestions, and the ticket's resolution summary in one place above
// the description. Driven by:
//   GET    /api/kb/tickets/:id/links
//   GET    /api/kb/tickets/:id/suggestions
//   POST   /api/kb/tickets/:id/links
//   DELETE /api/kb/tickets/:id/links/:articleId
//   PATCH  /api/tickets/:id { resolution_summary }
// Read-only for non-Admin/Manager/Tech (canEdit gates writes).
function KnowledgePanel({ ticketId, projectId, canEdit, isAdmin, ticketResolved, ticketRef, ticketExternalStatus, resolutionSummary, onResolutionChange }) {
  const [links, setLinks] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [picker, setPicker] = useState("");
  const [pickerHits, setPickerHits] = useState([]);
  const [resEdit, setResEdit] = useState(false);
  const [resDraft, setResDraft] = useState(resolutionSummary || "");
  const [resSaving, setResSaving] = useState(false);

  async function loadAll() {
    try { setLinks(await api.get(`/api/kb/tickets/${ticketId}/links`)); } catch { /* empty ok */ }
    try { setSuggestions(await api.get(`/api/kb/tickets/${ticketId}/suggestions?limit=5`)); } catch { setSuggestions([]); }
  }
  useEffect(() => { loadAll(); }, [ticketId]);
  useEffect(() => { setResDraft(resolutionSummary || ""); }, [resolutionSummary]);

  async function unlink(articleId) {
    try {
      await api.delete(`/api/kb/tickets/${ticketId}/links/${articleId}`);
      toast.success("Article unlinked");
      await loadAll();
    } catch (e) { toast.error(e.message); }
  }
  async function link(articleId, kind = "manual") {
    try {
      await api.post(`/api/kb/tickets/${ticketId}/links`, { article_id: articleId, kind });
      toast.success("Article linked");
      setPicker(""); setPickerHits([]);
      await loadAll();
    } catch (e) { toast.error(e.message); }
  }

  // Typeahead — searches across published articles. Server has no
  // dedicated /search endpoint yet, so we just GET tags then list a
  // small subset via project + global. Easier: piggyback on the
  // suggestions ranker by sending q via title-like body? Simplest:
  // fetch all visible KB articles once per session and filter
  // client-side. For now keep it lightweight — call suggestions with
  // a synthetic title override would require server change. Skip for
  // v1; the suggestions panel covers the 80% case.
  useEffect(() => {
    if (!picker || picker.length < 2) { setPickerHits([]); return; }
    let cancelled = false;
    (async () => {
      // Fall back to project's article list; ?q= isn't supported yet
      // server-side so we filter client-side.
      try {
        const r = await api.get(`/api/kb/projects/${projectId}/articles?status=published`);
        if (cancelled) return;
        const term = picker.toLowerCase();
        setPickerHits(
          (r || [])
            .filter((a) =>
              a.title.toLowerCase().includes(term)
              || (a.tags || []).some((t) => t.toLowerCase().includes(term))
            )
            .filter((a) => !links.find((l) => l.article_id === a.id))
            .slice(0, 8)
        );
      } catch { setPickerHits([]); }
    })();
    return () => { cancelled = true; };
  }, [picker, projectId, links]);

  async function saveResolution() {
    setResSaving(true);
    try {
      const next = resDraft.trim() || null;
      await onResolutionChange(next);
      setResEdit(false);
    } finally { setResSaving(false); }
  }

  // Close-time nudge: ticket is in a resolved/closed state but has
  // neither a resolution summary nor any KB links — soft prompt to
  // record the fix. Opt-in, not a forced modal.
  const showNudge = canEdit && ticketResolved && !resolutionSummary && links.length === 0;

  // One-click escape hatch for tickets the vendor fixed for us — no
  // internal write-up needed, but we still want the field populated so
  // the nudge stops nagging and audits show why nothing was logged.
  async function markVendorResolved() {
    try {
      await onResolutionChange("Resolved externally by vendor — no internal fix required.");
    } catch (e) { /* onResolutionChange toasts on failure */ }
  }

  async function promoteToKb() {
    if (!resolutionSummary || resolutionSummary.trim().length < 20) {
      toast.error("Add a resolution summary first (20+ chars).");
      return;
    }
    try {
      const article = await api.post(`/api/kb/from-ticket/${ticketId}`, {});
      toast.success("KB draft created from this ticket");
      window.location.href = `/kb/${article.project_id}/${article.slug}/edit`;
    } catch (e) { toast.error(e.message); }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-3 space-y-3">
      {showNudge && (
        <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-300 dark:border-amber-700 rounded p-2 text-xs flex flex-wrap items-start gap-2">
          <span className="text-amber-700 dark:text-amber-300 font-medium">Record how this was fixed?</span>
          <span className="text-amber-800 dark:text-amber-200 flex-1 min-w-[180px]">
            Adding a resolution summary or linking a KB article helps the next person hit the same issue.
          </span>
          <button
            onClick={() => setResEdit(true)}
            className="text-amber-900 dark:text-amber-200 hover:underline font-medium whitespace-nowrap"
          >
            Add summary →
          </button>
          <button
            onClick={markVendorResolved}
            className="text-amber-900 dark:text-amber-200 hover:underline font-medium whitespace-nowrap"
            title="Vendor handled it — skip logging an internal fix"
          >
            Resolved by vendor →
          </button>
        </div>
      )}

      {/* Linked articles */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-fg uppercase tracking-wide">
            Knowledge {links.length > 0 && <span className="text-fg-muted normal-case tracking-normal font-normal">({links.length})</span>}
          </div>
        </div>
        {links.length === 0 ? (
          <div className="text-xs text-fg-dim italic">No KB articles linked.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {links.map((l) => (
              <span key={l.article_id}
                className="inline-flex items-center gap-1 text-xs bg-brand/10 text-brand rounded px-2 py-1">
                <Link to={`/kb/${l.project_id}/${l.slug}`} className="hover:underline">{l.title}</Link>
                {canEdit && (
                  <button
                    onClick={() => unlink(l.article_id)}
                    className="text-brand/70 hover:text-red-600"
                    title="Unlink"
                  >×</button>
                )}
              </span>
            ))}
          </div>
        )}

        {canEdit && (
          <div className="relative">
            <input
              type="text"
              value={picker}
              onChange={(e) => setPicker(e.target.value)}
              placeholder="Link an article by title or tag…"
              className="w-full bg-surface-2 border border-border rounded px-2 py-1 text-xs"
            />
            {pickerHits.length > 0 && (
              <div className="absolute z-20 left-0 right-0 mt-1 bg-surface border border-border rounded-md shadow-lg max-h-64 overflow-y-auto">
                {pickerHits.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => link(a.id, "manual")}
                    className="w-full text-left px-3 py-2 hover:bg-surface-2 text-xs"
                  >
                    <div className="font-medium text-fg">{a.title}</div>
                    {a.tags?.length > 0 && (
                      <div className="text-[10px] text-fg-dim mt-0.5">{a.tags.join(", ")}</div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Suggestions */}
      {canEdit && suggestions.length > 0 && (
        <div className="space-y-1 border-t border-border pt-2">
          <div className="text-[11px] text-fg-muted uppercase tracking-wide">Suggested</div>
          <div className="space-y-1">
            {suggestions.map((s) => (
              <div key={s.article_id} className="flex items-center gap-2 text-xs">
                <Link to={`/kb/${s.project_id}/${s.slug}`} className="text-brand hover:underline flex-1 truncate">
                  {s.title}
                </Link>
                <span className="text-fg-dim font-mono">{Number(s.sim).toFixed(2)}</span>
                <button
                  onClick={() => link(s.article_id, "suggested_accepted")}
                  className="text-[11px] px-2 py-0.5 bg-brand text-white rounded"
                >
                  Link
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Resolution summary */}
      <div className="border-t border-border pt-2 space-y-1">
        <div className="flex items-center justify-between">
          <div className="text-[11px] text-fg-muted uppercase tracking-wide">Resolution summary</div>
          <div className="flex items-center gap-2">
            {isAdmin && resolutionSummary && (
              <button
                onClick={promoteToKb}
                className="text-[11px] text-brand hover:underline"
                title="Draft a KB article seeded with this resolution + the ticket description"
              >
                Promote to KB →
              </button>
            )}
            {canEdit && !resEdit && (
              <button
                onClick={() => setResEdit(true)}
                className="text-[11px] text-brand hover:underline"
              >
                {resolutionSummary ? "Edit" : "Add"}
              </button>
            )}
          </div>
        </div>
        {resEdit ? (
          <div className="space-y-1">
            <textarea
              value={resDraft}
              onChange={(e) => setResDraft(e.target.value)}
              placeholder="What fixed it? (markdown ok)"
              rows={4}
              className="w-full bg-surface-2 border border-border rounded px-2 py-1.5 text-xs"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={saveResolution}
                disabled={resSaving}
                className="text-xs px-2 py-1 bg-brand text-white rounded disabled:opacity-50"
              >
                {resSaving ? "Saving…" : "Save"}
              </button>
              <button
                onClick={() => { setResEdit(false); setResDraft(resolutionSummary || ""); }}
                className="text-xs text-fg-muted hover:text-fg"
              >Cancel</button>
              {resolutionSummary && (
                <button
                  onClick={async () => { await onResolutionChange(null); setResEdit(false); }}
                  className="ml-auto text-xs text-red-600 hover:underline"
                >Clear</button>
              )}
            </div>
          </div>
        ) : resolutionSummary ? (
          <div className="text-xs text-fg">
            <MarkdownContent>{resolutionSummary}</MarkdownContent>
          </div>
        ) : (
          <div className="text-xs text-fg-dim italic">Not recorded yet.</div>
        )}
      </div>
    </div>
  );
}
