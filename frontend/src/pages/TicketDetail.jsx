import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { api } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import {
  formatDateTime, computePriority, priorityClass,
  INTERNAL_STATUSES, COASTAL_STATUSES, IMPACT_LABELS, URGENCY_LABELS
} from '../utils/helpers';
import { useStatuses, nextAllowedStatusIds, statusByName, suggestedExternalForInternal } from '../context/StatusesContext';
import PriorityBadge from '../components/PriorityBadge';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(name, mime) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext)) return '🖼️';
  if (['pdf'].includes(ext)) return '📄';
  if (['html','htm'].includes(ext)) return '🌐';
  if (['txt','log','md','csv'].includes(ext)) return '📝';
  if (['zip','gz','tar','7z','rar'].includes(ext)) return '🗜️';
  if (['js','ts','jsx','tsx','json','yml','yaml','py','rb','sh','sql'].includes(ext)) return '💾';
  if ((mime || '').startsWith('image/')) return '🖼️';
  return '📎';
}

function CommentActionDropdown({ disabled, onPostAndClose, onPostAndReopen }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className="btn-secondary btn btn-sm disabled:opacity-50 flex items-center gap-1"
      >
        Post &amp; …
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 w-44 bg-white rounded-md shadow-lg border border-gray-200 z-20 py-1">
          <button
            type="button"
            onClick={() => { setOpen(false); onPostAndClose(); }}
            className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Post &amp; Close
          </button>
          <button
            type="button"
            onClick={() => { setOpen(false); onPostAndReopen(); }}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
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
      <dt className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-1">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const statusCfg = useStatuses();
  const isAdmin = user?.role === 'Admin';
  const isSubmitter = user?.role === 'Submitter';
  const canEdit = isAdmin || isSubmitter;

  const [ticket, setTicket] = useState(null);
  const [comments, setComments] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [commentBody, setCommentBody] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [activeTab, setActiveTab] = useState('comments');
  const [confirm, setConfirm] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [followers, setFollowers] = useState([]);
  const [followLoading, setFollowLoading] = useState(false);

  // Inline edit state
  const [editing, setEditing] = useState({});
  const [editValues, setEditValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [blockingSearch, setBlockingSearch] = useState('');
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
      api.get(`/api/tickets/${id}/audit`),
      api.get(`/api/tickets/${id}/attachments`),
      api.get(`/api/tickets/${id}/followers`),
    ])
      .then(([, audit, atts, fols]) => { setAuditLog(audit); setAttachments(atts); setFollowers(fols); setLoading(false); })
      .catch(() => setLoading(false));
  }, [id, loadTicket]);

  async function uploadFiles(files) {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      Array.from(files).forEach(f => formData.append('files', f));
      const res = await fetch(`/api/tickets/${id}/attachments`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Upload failed'); }
      const inserted = await res.json();
      setAttachments(prev => [...prev, ...inserted]);
      toast.success(`${inserted.length} file${inserted.length > 1 ? 's' : ''} uploaded`);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
    }
  }

  async function deleteAttachment(attId) {
    try {
      await api.delete(`/api/attachments/${attId}`);
      setAttachments(prev => prev.filter(a => a.id !== attId));
      toast.success('Attachment deleted');
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
      toast.success('Saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
      setEditing({});
    }
  }

  async function submitComment(e, andStatus = null) {
    if (e) e.preventDefault();
    if (!commentBody.trim()) return;
    setSubmittingComment(true);
    try {
      const c = await api.post(`/api/tickets/${id}/comments`, { body: commentBody.trim() });
      setComments(prev => [...prev, c]);
      setCommentBody('');
      if (andStatus) {
        const updated = await api.patch(`/api/tickets/${id}`, {
          internal_status: andStatus,
          ...(andStatus === 'Closed' ? { flagged_for_review: false } : {}),
        });
        setTicket(updated);
        const audit = await api.get(`/api/tickets/${id}/audit`);
        setAuditLog(audit);
        toast.success(`Comment posted — ticket ${andStatus.toLowerCase()}`);
      } else {
        toast.success('Comment posted');
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
      toast.success('Ticket deleted');
      navigate('/tickets');
    } catch (err) {
      toast.error(err.message);
    }
    setConfirm(null);
  }

  async function searchBlocking(q) {
    if (!q || q.length < 2) { setBlockingResults([]); return; }
    const data = await api.get(`/api/tickets?sort_by=mot_ref&sort_dir=asc&limit=10`);
    const filtered = data.tickets.filter(t => t.id !== ticket.id && (t.mot_ref.includes(q.toUpperCase()) || t.title.toLowerCase().includes(q.toLowerCase())));
    setBlockingResults(filtered);
  }

  if (loading) return <div className="text-gray-400 py-12 text-center">Loading...</div>;
  if (!ticket) return <div className="text-gray-500 py-12 text-center">Ticket not found</div>;

  const liveComputed = computePriority(
    editValues.impact ?? ticket.impact,
    editValues.urgency ?? ticket.urgency
  );

  const isFollowing = followers.some(f => f.id === user?.id);

  async function toggleFollow() {
    setFollowLoading(true);
    try {
      if (isFollowing) {
        await fetch(`/api/tickets/${id}/follow`, { method: 'DELETE', credentials: 'include' });
        setFollowers(prev => prev.filter(f => f.id !== user.id));
        toast.success('Unfollowed');
      } else {
        await fetch(`/api/tickets/${id}/follow`, { method: 'POST', credentials: 'include' });
        setFollowers(prev => [...prev, { id: user.id, display_name: user.displayName, email: user.email }]);
        toast.success('Following — you\'ll get email updates');
      }
    } catch {
      toast.error('Failed to update follow status');
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
            <span className="font-mono text-sm font-semibold text-gray-500">{ticket.mot_ref}</span>
            <PriorityBadge priority={ticket.effective_priority} override={ticket.priority_override} computed={ticket.computed_priority} />
            <StatusBadge status={ticket.internal_status} />
            {ticket.flagged_for_review ? <span className="text-xs font-semibold text-purple-700 bg-purple-100 px-2 py-0.5 rounded-full">★ Flagged for Review</span> : null}
          </div>
          <h1 className="text-xl font-semibold text-gray-900 mt-2">{ticket.title}</h1>
          <p className="text-xs text-gray-400 mt-1">
            Submitted by {ticket.submitted_by_name} · {formatDateTime(ticket.created_at)}
            {ticket.assigned_to_name && ` · Assigned: ${ticket.assigned_to_name}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={toggleFollow}
            disabled={followLoading}
            title={followers.length ? `${followers.map(f => f.display_name).join(', ')} following` : 'No followers yet'}
            className={`btn btn-sm flex items-center gap-1.5 ${isFollowing ? 'bg-blue-50 border border-blue-300 text-blue-700 hover:bg-red-50 hover:border-red-300 hover:text-red-600' : 'btn-secondary'}`}
          >
            <svg className="w-3.5 h-3.5" fill={isFollowing ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            {isFollowing ? 'Following' : 'Follow'}
            {followers.length > 0 && <span className="ml-0.5 text-xs opacity-70">· {followers.length}</span>}
          </button>
          {isAdmin && (
            <button onClick={() => setConfirm('delete')} className="btn-danger btn btn-sm whitespace-nowrap">Delete</button>
          )}
        </div>
      </div>

      {/* Awaiting MOT Input banner */}
      {ticket.blocker_type === 'mot_input' && (
        <div className="bg-amber-50 border-2 border-amber-400 rounded-lg px-4 py-3 flex items-start gap-3">
          <span className="text-amber-500 text-xl mt-0.5">⚠</span>
          <div>
            <div className="font-semibold text-amber-800">Awaiting MOT Input</div>
            <div className="text-sm text-amber-700 mt-0.5">{ticket.mot_blocker_note || 'MOT action required before the external partner can proceed.'}</div>
          </div>
        </div>
      )}

      {/* Pending Review banner */}
      {ticket.flagged_for_review && ticket.internal_status === 'Pending Review' && (
        <div className="bg-purple-50 border-2 border-purple-400 rounded-lg px-4 py-3">
          <div className="font-semibold text-purple-800 mb-2">Pending Review — External partner marked this Resolved</div>
          <p className="text-sm text-purple-700 mb-3">Verify the fix, then close or reopen this ticket.</p>
          {isAdmin && (
            <div className="flex gap-2">
              <button onClick={() => patch({ internal_status: 'Closed', flagged_for_review: false })} className="btn-primary btn btn-sm">Close Ticket</button>
              <button onClick={() => patch({ internal_status: 'Reopened', flagged_for_review: false })} className="btn-danger btn btn-sm">Reopen</button>
            </div>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Left: main details */}
        <div className="lg:col-span-2 space-y-4">
          {/* Description */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-gray-700">Description</h2>
              {canEdit && !editing.description && (
                <button onClick={() => { setEditing({ description: true }); setEditValues({ description: ticket.description || '' }); }}
                  className="text-xs text-blue-600 hover:underline">Edit</button>
              )}
            </div>
            {editing.description ? (
              <div className="space-y-2">
                <textarea value={editValues.description} onChange={e => setEditValues(v => ({...v, description: e.target.value}))}
                  rows={5} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                <div className="flex gap-2">
                  <button onClick={() => patch({ description: editValues.description })} disabled={saving} className="btn-primary btn btn-sm">Save</button>
                  <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">Cancel</button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{ticket.description || <span className="text-gray-400">No description</span>}</p>
            )}
          </div>

          {/* Comments + Audit + Attachments tabs */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="flex border-b border-gray-200">
              <button onClick={() => setActiveTab('comments')}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'comments' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}>
                Comments ({comments.length})
              </button>
              <button onClick={() => setActiveTab('attachments')}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'attachments' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}>
                Attachments {attachments.length > 0 && `(${attachments.length})`}
              </button>
              <button onClick={() => setActiveTab('audit')}
                className={`px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'audit' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500 hover:text-gray-700'}`}>
                Audit Log
              </button>
            </div>

            {activeTab === 'comments' && (
              <div className="p-4 space-y-4">
                {comments.length === 0 && <p className="text-sm text-gray-400 text-center py-4">No comments yet</p>}
                {comments.map(c => (
                  <div key={c.id} className={`rounded-lg p-3 ${c.is_system ? 'bg-blue-50 border border-blue-200' : 'bg-gray-50'}`}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold text-gray-600">{c.is_system ? '🤖 System' : c.user_name}</span>
                      <span className="text-xs text-gray-400">{formatDateTime(c.created_at)}</span>
                    </div>
                    <p className="text-sm text-gray-700 whitespace-pre-wrap">{c.body}</p>
                  </div>
                ))}
                {canEdit && (
                  <form onSubmit={submitComment} className="space-y-2 pt-2 border-t border-gray-200">
                    <textarea value={commentBody} onChange={e => setCommentBody(e.target.value)} rows={3}
                      className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Add a comment..." />
                    <div className="flex items-center gap-2">
                      <button type="submit" disabled={submittingComment || !commentBody.trim()} className="btn-primary btn btn-sm disabled:opacity-50">
                        {submittingComment ? 'Posting...' : 'Post'}
                      </button>
                      {isAdmin && (
                        <CommentActionDropdown
                          disabled={submittingComment || !commentBody.trim()}
                          onPostAndClose={() => submitComment(null, 'Closed')}
                          onPostAndReopen={() => submitComment(null, 'Reopened')}
                        />
                      )}
                    </div>
                  </form>
                )}
              </div>
            )}

            {activeTab === 'attachments' && (
              <div className="p-4 space-y-4">
                {/* Drop zone */}
                {canEdit && (
                  <div
                    onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={e => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files); }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors ${
                      dragOver ? 'border-blue-400 bg-blue-50' : 'border-gray-300 hover:border-gray-400'
                    }`}
                  >
                    <p className="text-sm text-gray-500 mb-2">
                      {uploading ? 'Uploading…' : 'Drag & drop files here, or'}
                    </p>
                    <label className={`btn-secondary btn btn-sm cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
                      Browse files
                      <input type="file" multiple className="hidden"
                        onChange={e => { uploadFiles(e.target.files); e.target.value = ''; }} />
                    </label>
                    <p className="text-xs text-gray-400 mt-2">Any file type · 50 MB max per file</p>
                  </div>
                )}

                {/* List */}
                {attachments.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-4">No attachments yet</p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {attachments.map(a => (
                      <li key={a.id} className="flex items-center gap-3 py-2.5">
                        <span className="text-xl">{fileIcon(a.original_name, a.mimetype)}</span>
                        <div className="flex-1 min-w-0">
                          <a href={`/api/attachments/${a.id}`}
                            className="text-sm font-medium text-blue-700 hover:underline truncate block"
                            download={a.original_name}>
                            {a.original_name}
                          </a>
                          <span className="text-xs text-gray-400">
                            {formatBytes(a.size)} · {a.uploaded_by_name || 'Unknown'} · {formatDateTime(a.created_at)}
                          </span>
                        </div>
                        {(user?.role === 'Admin' || a.user_id === user?.id) && (
                          <button onClick={() => deleteAttachment(a.id)}
                            className="text-xs text-gray-300 hover:text-red-500 transition-colors flex-shrink-0">
                            Delete
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {activeTab === 'audit' && (
              <div className="divide-y divide-gray-100">
                {auditLog.length === 0 && <p className="text-sm text-gray-400 text-center py-6">No audit entries</p>}
                {auditLog.map(a => (
                  <div key={a.id} className="px-4 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm">
                        <span className="font-medium text-gray-700">{a.action.replace(/_/g, ' ')}</span>
                        {a.old_value && <span className="text-gray-400"> {a.old_value}</span>}
                        {a.new_value && <span className="text-gray-600"> → {a.new_value}</span>}
                        {a.note && <span className="text-gray-400 ml-1">({a.note})</span>}
                      </div>
                      <span className="text-xs text-gray-400 whitespace-nowrap">{formatDateTime(a.created_at)}</span>
                    </div>
                    <div className="text-xs text-gray-400 mt-0.5">{a.user_name || 'System'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right: metadata panel */}
        <div className="space-y-4">
          {/* Priority */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">Priority</h2>
            <dl className="space-y-3">
              <Field label="Impact">
                {editing.impact ? (
                  <select value={editValues.impact} onChange={e => setEditValues(v => ({...v, impact: Number(e.target.value)}))}
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-full">
                    {[1,2,3].map(v => <option key={v} value={v}>{IMPACT_LABELS[v]}</option>)}
                  </select>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">{IMPACT_LABELS[ticket.impact]}</span>
                    {canEdit && <button onClick={() => { setEditing({ impact: true, urgency: true }); setEditValues({ impact: ticket.impact, urgency: ticket.urgency }); }} className="text-xs text-blue-600 hover:underline">Edit</button>}
                  </div>
                )}
              </Field>
              <Field label="Urgency">
                {editing.urgency ? (
                  <select value={editValues.urgency} onChange={e => setEditValues(v => ({...v, urgency: Number(e.target.value)}))}
                    className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-full">
                    {[1,2,3].map(v => <option key={v} value={v}>{URGENCY_LABELS[v]}</option>)}
                  </select>
                ) : (
                  <span className="text-sm text-gray-700">{URGENCY_LABELS[ticket.urgency]}</span>
                )}
              </Field>
              {(editing.impact || editing.urgency) && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">Preview:</span>
                  <PriorityBadge priority={liveComputed} />
                  <button onClick={() => patch({ impact: editValues.impact, urgency: editValues.urgency })} disabled={saving} className="btn-primary btn btn-sm ml-auto">Save</button>
                  <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">×</button>
                </div>
              )}
              <Field label="Computed Priority">
                <PriorityBadge priority={ticket.computed_priority} />
              </Field>
              {isAdmin && (
                <Field label="Priority Override">
                  {editing.priority_override ? (
                    <div className="flex gap-2 items-center">
                      <select value={editValues.priority_override ?? ''} onChange={e => setEditValues(v => ({...v, priority_override: e.target.value === '' ? null : Number(e.target.value)}))}
                        className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500">
                        <option value="">No override</option>
                        {[1,2,3,4,5].map(p => <option key={p} value={p}>P{p}</option>)}
                      </select>
                      <button onClick={() => patch({ priority_override: editValues.priority_override ?? null })} disabled={saving} className="btn-primary btn btn-sm">Save</button>
                      <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">×</button>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      {ticket.priority_override ? <PriorityBadge priority={ticket.priority_override} override={ticket.priority_override} computed={ticket.computed_priority} /> : <span className="text-sm text-gray-400">None</span>}
                      <button onClick={() => { setEditing({ priority_override: true }); setEditValues({ priority_override: ticket.priority_override }); }} className="text-xs text-blue-600 hover:underline">Edit</button>
                    </div>
                  )}
                </Field>
              )}
              <Field label="Effective Priority">
                <PriorityBadge priority={ticket.effective_priority} override={ticket.priority_override} computed={ticket.computed_priority} />
              </Field>
            </dl>
          </div>

          {/* Status */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">Status</h2>
            <dl className="space-y-3">
              <Field label="Internal Status">
                {isAdmin && editing.internal_status ? (
                  <div className="flex gap-2">
                    {(() => {
                      const cur = statusByName(statusCfg.internal, ticket.internal_status);
                      const allowedIds = cur ? new Set(nextAllowedStatusIds(statusCfg.transitions, cur.id)) : null;
                      const opts = statusCfg.internal.length ? statusCfg.internal.map(s => s.name) : INTERNAL_STATUSES;
                      const labelFor = (name) => {
                        if (!cur || !allowedIds) return name;
                        const def = statusByName(statusCfg.internal, name);
                        if (def && def.id === cur.id) return name;
                        return def && allowedIds.has(def.id) ? `→ ${name}` : name;
                      };
                      return (
                        <select
                          value={editValues.internal_status}
                          onChange={e => setEditValues(v => ({ ...v, internal_status: e.target.value }))}
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 flex-1"
                        >
                          {opts.map(s => <option key={s} value={s}>{labelFor(s)}</option>)}
                        </select>
                      );
                    })()}
                    <button onClick={() => patch({ internal_status: editValues.internal_status })} disabled={saving} className="btn-primary btn btn-sm">Save</button>
                    <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">×</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <StatusBadge status={ticket.internal_status} />
                    {isAdmin && <button onClick={() => { setEditing({ internal_status: true }); setEditValues({ internal_status: ticket.internal_status }); }} className="text-xs text-blue-600 hover:underline">Edit</button>}
                  </div>
                )}
              </Field>
            </dl>
          </div>

          {/* External */}
          {ticket.project_has_external_vendor !== false && <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-3">
            <h2 className="text-sm font-semibold text-gray-700">External Vendor</h2>
            <dl className="space-y-3">
              <Field label="External Status">
                {isAdmin && editing.coastal_status ? (
                  <div className="space-y-2">
                    {(() => {
                      const opts = statusCfg.external.length ? statusCfg.external.map(s => s.name) : COASTAL_STATUSES;
                      const cur = statusByName(statusCfg.external, ticket.coastal_status);
                      const allowedIds = cur ? new Set(nextAllowedStatusIds(statusCfg.transitions, cur.id)) : null;
                      const labelFor = (name) => {
                        if (!cur || !allowedIds) return name;
                        const def = statusByName(statusCfg.external, name);
                        if (def && def.id === cur.id) return name;
                        return def && allowedIds.has(def.id) ? `→ ${name}` : name;
                      };
                      return (
                        <select
                          value={editValues.coastal_status}
                          onChange={e => setEditValues(v => ({ ...v, coastal_status: e.target.value }))}
                          className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 w-full"
                        >
                          {opts.map(s => <option key={s} value={s}>{labelFor(s)}</option>)}
                        </select>
                      );
                    })()}
                    {(() => {
                      const internalCur = statusByName(statusCfg.internal, ticket.internal_status);
                      if (!internalCur) return null;
                      const sugg = suggestedExternalForInternal(statusCfg.mappings, internalCur.id);
                      if (!sugg.length) return null;
                      const names = sugg
                        .map(m => statusCfg.external.find(s => s.id === m.external_status_id)?.name)
                        .filter(Boolean);
                      if (!names.length) return null;
                      return <p className="text-xs text-gray-500">Suggested for {ticket.internal_status}: {names.join(', ')}</p>;
                    })()}
                    <div className="flex gap-2">
                      <button onClick={() => patch({ coastal_status: editValues.coastal_status })} disabled={saving} className="btn-primary btn btn-sm">Save</button>
                      <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">{ticket.coastal_status}</span>
                    {isAdmin && <button onClick={() => { setEditing({ coastal_status: true }); setEditValues({ coastal_status: ticket.coastal_status }); }} className="text-xs text-blue-600 hover:underline">Edit</button>}
                  </div>
                )}
              </Field>
              <Field label="External Ticket Ref">
                {isAdmin && editing.coastal_ticket_ref ? (
                  <div className="flex gap-2">
                    <input type="text" value={editValues.coastal_ticket_ref || ''} onChange={e => setEditValues(v => ({...v, coastal_ticket_ref: e.target.value}))}
                      className="border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500 flex-1" />
                    <button onClick={() => patch({ coastal_ticket_ref: editValues.coastal_ticket_ref })} disabled={saving} className="btn-primary btn btn-sm">Save</button>
                    <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">×</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-gray-700">{ticket.coastal_ticket_ref || <span className="text-gray-400">—</span>}</span>
                    {isAdmin && <button onClick={() => { setEditing({ coastal_ticket_ref: true }); setEditValues({ coastal_ticket_ref: ticket.coastal_ticket_ref || '' }); }} className="text-xs text-blue-600 hover:underline">Edit</button>}
                  </div>
                )}
              </Field>
              {ticket.coastal_updated_at && (
                <Field label="External Updated">
                  <span className="text-xs text-gray-500">{formatDateTime(ticket.coastal_updated_at)}</span>
                </Field>
              )}
            </dl>
          </div>}

          {/* Blocker */}
          {isAdmin && (
            <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-gray-700">Blocker</h2>
                {!editing.blocker && ticket.blocker_type && (
                  <button onClick={() => patch({ blocker_type: null })} className="text-xs text-red-500 hover:underline">Clear</button>
                )}
              </div>
              {!editing.blocker && !ticket.blocker_type && (
                <div className="flex gap-2">
                  <button onClick={() => { setEditing({ blocker: 'internal' }); setEditValues({ blocked_by_ticket: null }); }} className="btn-secondary btn btn-sm">+ Internal Blocker</button>
                  <button onClick={() => { setEditing({ blocker: 'mot_input' }); setEditValues({ mot_blocker_note: '' }); }} className="btn-secondary btn btn-sm">+ MOT Input</button>
                </div>
              )}
              {ticket.blocker_type === 'internal' && !editing.blocker && (
                <div className="text-sm text-gray-700">
                  Blocked by: <span className="font-medium text-red-700">{ticket.blocking_ticket_ref}</span> — {ticket.blocking_ticket_title}
                  <span className={`ml-2 text-xs ${ticket.blocking_ticket_status === 'Closed' ? 'text-green-600' : 'text-red-500'}`}>({ticket.blocking_ticket_status})</span>
                </div>
              )}
              {ticket.blocker_type === 'mot_input' && !editing.blocker && (
                <div className="text-sm text-amber-700">{ticket.mot_blocker_note}</div>
              )}
              {editing.blocker === 'internal' && (
                <div className="space-y-2">
                  <input type="text" placeholder="Search by ref or title..." value={blockingSearch}
                    onChange={e => { setBlockingSearch(e.target.value); searchBlocking(e.target.value); }}
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  {blockingResults.length > 0 && (
                    <ul className="border border-gray-200 rounded-md divide-y">
                      {blockingResults.map(r => (
                        <li key={r.id}>
                          <button onClick={() => { setEditValues(v => ({...v, blocked_by_ticket: r.id})); setBlockingSearch(`${r.mot_ref} — ${r.title}`); setBlockingResults([]); }}
                            className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50">
                            <span className="font-mono font-medium">{r.mot_ref}</span> — {r.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button onClick={() => patch({ blocker_type: 'internal', blocked_by_ticket: editValues.blocked_by_ticket })} disabled={saving || !editValues.blocked_by_ticket} className="btn-primary btn btn-sm disabled:opacity-50">Set Blocker</button>
                    <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">Cancel</button>
                  </div>
                </div>
              )}
              {editing.blocker === 'mot_input' && (
                <div className="space-y-2">
                  <textarea value={editValues.mot_blocker_note || ''} onChange={e => setEditValues(v => ({...v, mot_blocker_note: e.target.value}))}
                    rows={3} placeholder="What does MOT need to provide to the external partner?"
                    className="w-full border border-gray-300 rounded-md px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  <div className="flex gap-2">
                    <button onClick={() => patch({ blocker_type: 'mot_input', mot_blocker_note: editValues.mot_blocker_note })} disabled={saving} className="btn-primary btn btn-sm">Set Blocker</button>
                    <button onClick={() => setEditing({})} className="btn-secondary btn btn-sm">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirm === 'delete'}
        title="Delete Ticket"
        message={`Permanently delete ${ticket.mot_ref}? This cannot be undone.`}
        confirmLabel="Delete"
        danger
        onConfirm={deleteTicket}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
