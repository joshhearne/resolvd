import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';

const PRIORITY_LABELS = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4', 5: 'P5' };
const PRIORITY_COLORS = {
  1: 'bg-red-100 text-red-700',
  2: 'bg-orange-100 text-orange-700',
  3: 'bg-yellow-100 text-yellow-700',
  4: 'bg-gray-100 text-gray-600',
  5: 'bg-gray-50 text-gray-500',
};

export default function DuplicateWarningModal({ matches, newDescription, onCreateAnyway, onClose }) {
  const navigate = useNavigate();
  const [commenting, setCommenting] = useState(null); // ticket id
  const [commentText, setCommentText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function submitComment(ticket) {
    if (!commentText.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/tickets/${ticket.id}/comments`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: commentText.trim(), is_internal: false }),
      });
      if (!res.ok) throw new Error();
      toast.success(`Comment added to ${ticket.mot_ref}`);
      navigate(`/tickets/${ticket.id}`);
    } catch {
      toast.error('Failed to add comment');
    } finally {
      setSubmitting(false);
    }
  }

  function startComment(ticket) {
    setCommenting(ticket.id);
    setCommentText(newDescription || '');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="p-5 border-b border-amber-200 bg-amber-50 rounded-t-xl">
          <div className="flex items-start gap-3">
            <div className="text-amber-500 text-2xl flex-shrink-0">⚠️</div>
            <div>
              <h2 className="text-base font-bold text-amber-900">Possible duplicate detected</h2>
              <p className="text-sm text-amber-700 mt-0.5">
                These open tickets may cover the same issue. Consider adding a comment to an existing one instead of creating a new ticket.
              </p>
            </div>
          </div>
        </div>

        {/* Matches */}
        <div className="p-4 space-y-3">
          {matches.map(ticket => (
            <div key={ticket.id} className="border border-gray-200 rounded-lg overflow-hidden">
              <div className="p-3 flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs font-semibold text-gray-500">{ticket.mot_ref}</span>
                    {ticket.project_name && (
                      <span className="text-xs text-gray-400">{ticket.project_name}</span>
                    )}
                    <span className={`text-xs font-semibold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[ticket.effective_priority]}`}>
                      {PRIORITY_LABELS[ticket.effective_priority]}
                    </span>
                    <span className="text-xs text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded">{ticket.internal_status}</span>
                  </div>
                  <p className="text-sm font-medium text-gray-800 mt-1">{ticket.title}</p>
                  {ticket.description && (
                    <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{ticket.description}</p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5 flex-shrink-0">
                  <a
                    href={`/tickets/${ticket.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn-secondary btn-sm btn text-xs"
                  >
                    View
                  </a>
                  {commenting !== ticket.id && (
                    <button
                      onClick={() => startComment(ticket)}
                      className="btn-primary btn-sm btn text-xs"
                    >
                      Add comment
                    </button>
                  )}
                </div>
              </div>

              {/* Inline comment form */}
              {commenting === ticket.id && (
                <div className="border-t border-blue-100 bg-blue-50 p-3 space-y-2">
                  <p className="text-xs font-medium text-blue-800">Add your note to <strong>{ticket.mot_ref}</strong> instead of creating a new ticket:</p>
                  <textarea
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    rows={4}
                    className="w-full border border-blue-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-white"
                    placeholder="Describe what you're seeing…"
                  />
                  <div className="flex gap-2">
                    <button
                      onClick={() => submitComment(ticket)}
                      disabled={submitting || !commentText.trim()}
                      className="btn-primary btn-sm btn"
                    >
                      {submitting ? 'Submitting…' : 'Submit comment'}
                    </button>
                    <button onClick={() => setCommenting(null)} className="btn-secondary btn-sm btn">Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3 bg-gray-50 rounded-b-xl">
          <button onClick={onClose} className="btn-secondary btn text-sm">
            ← Go back and edit
          </button>
          <button onClick={onCreateAnyway} className="btn-danger btn text-sm w-full sm:w-auto">
            Create new ticket anyway
          </button>
        </div>
      </div>
    </div>
  );
}
