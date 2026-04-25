import React, { useEffect, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBranding } from '../context/BrandingContext';

const PRIORITY_LABELS = { 1: 'P1 – Critical', 2: 'P2 – High', 3: 'P3 – Medium', 4: 'P4 – Low', 5: 'P5 – Minimal' };
const PRIORITY_COLORS = { 1: '#b91c1c', 2: '#c2410c', 3: '#a16207', 4: '#374151', 5: '#6b7280' };

function groupSort(tickets) {
  function grp(t) {
    if (t.blocker_type) return 0;
    if (t.internal_status === 'Closed') return 2;
    return 1;
  }
  return [...tickets].sort((a, b) => {
    const gd = grp(a) - grp(b);
    if (gd !== 0) return gd;
    const pd = (a.effective_priority || 3) - (b.effective_priority || 3);
    if (pd !== 0) return pd;
    return (a.mot_ref || '').localeCompare(b.mot_ref || '');
  });
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function GroupHeading({ label }) {
  return (
    <div style={{
      background: '#1e3a5f', color: '#fff', padding: '6px 12px',
      fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em',
      textTransform: 'uppercase', marginTop: '24px', marginBottom: '12px',
      pageBreakAfter: 'avoid',
    }}>
      {label}
    </div>
  );
}

function TicketCard({ ticket }) {
  const isReopened = ticket.internal_status === 'Reopened';
  const pri = ticket.effective_priority || 3;

  return (
    <div style={{
      border: '1px solid #d1d5db', borderRadius: '6px', marginBottom: '16px',
      pageBreakInside: 'avoid', overflow: 'hidden',
    }}>
      {/* Reopened banner */}
      {isReopened && (
        <div style={{
          background: '#fef2f2', borderBottom: '2px solid #dc2626',
          padding: '8px 14px', display: 'flex', gap: '8px', alignItems: 'flex-start',
        }}>
          <span style={{
            background: '#dc2626', color: '#fff', fontSize: '10px', fontWeight: 700,
            padding: '2px 7px', borderRadius: '3px', flexShrink: 0, marginTop: '1px',
          }}>REOPENED</span>
          <span style={{ fontSize: '12px', color: '#7f1d1d', lineHeight: 1.4 }}>
            {ticket.review_note || 'This ticket was reopened for additional review.'}
          </span>
        </div>
      )}

      {/* Header row */}
      <div style={{
        background: '#f9fafb', borderBottom: '1px solid #e5e7eb',
        padding: '10px 14px', display: 'flex', alignItems: 'center', gap: '10px',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: '13px', fontWeight: 700, color: '#111827', flexShrink: 0 }}>
          {ticket.mot_ref}
        </span>
        {ticket.coastal_ticket_ref && (
          <span style={{
            fontSize: '11px', background: '#eff6ff', color: '#1d4ed8',
            border: '1px solid #bfdbfe', borderRadius: '4px', padding: '1px 7px', flexShrink: 0,
          }}>
            Ext: {ticket.coastal_ticket_ref}
          </span>
        )}
        <span style={{
          fontSize: '11px', fontWeight: 600, color: PRIORITY_COLORS[pri], flexShrink: 0,
        }}>
          {PRIORITY_LABELS[pri]}
        </span>
        <span style={{
          fontSize: '11px', color: '#6b7280', marginLeft: 'auto', flexShrink: 0,
        }}>
          {ticket.internal_status}
          {ticket.coastal_status && ticket.coastal_status !== 'Unacknowledged'
            ? ` · Ext: ${ticket.coastal_status}` : ''}
        </span>
      </div>

      {/* Title + meta */}
      <div style={{ padding: '10px 14px 6px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#111827', marginBottom: '6px' }}>
          {ticket.title}
        </div>
        <div style={{ fontSize: '11px', color: '#6b7280', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          {ticket.project_name && <span>Project: {ticket.project_name}</span>}
          {ticket.submitter_name && <span>Submitted by: {ticket.submitter_name}</span>}
          {ticket.assignee_name && <span>Assigned: {ticket.assignee_name}</span>}
          <span>Created: {fmt(ticket.created_at)}</span>
          <span>Updated: {fmt(ticket.updated_at)}</span>
        </div>
      </div>

      {/* Blocker info */}
      {ticket.blocker_type && (
        <div style={{
          margin: '0 14px 8px', background: '#fff7ed', border: '1px solid #fed7aa',
          borderRadius: '4px', padding: '6px 10px', fontSize: '12px', color: '#9a3412',
        }}>
          <strong>Blocked:</strong> {ticket.blocker_type}
          {ticket.mot_blocker_note ? ` — ${ticket.mot_blocker_note}` : ''}
        </div>
      )}

      {/* Description */}
      {ticket.description && (
        <div style={{
          padding: '4px 14px 12px', fontSize: '12px', color: '#374151',
          lineHeight: 1.6, whiteSpace: 'pre-wrap',
        }}>
          {ticket.description}
        </div>
      )}

      {/* Inline images */}
      {Array.isArray(ticket.images) && ticket.images.length > 0 && (
        <div style={{ padding: '0 14px 12px' }}>
          <div style={{ fontSize: '11px', fontWeight: 600, color: '#6b7280', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Screenshots / Attachments
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {ticket.images.map(img => (
              <div key={img.id} style={{ pageBreakInside: 'avoid' }}>
                <img
                  src={`/api/attachments/${img.id}/view`}
                  alt={img.original_name}
                  style={{ maxWidth: '100%', maxHeight: '320px', objectFit: 'contain', border: '1px solid #e5e7eb', borderRadius: '4px' }}
                />
                <div style={{ fontSize: '10px', color: '#9ca3af', marginTop: '2px', textAlign: 'center' }}>
                  {img.original_name}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PrintExport() {
  const [params] = useSearchParams();
  const { branding } = useBranding();
  const [tickets, setTickets] = useState(null);
  const [error, setError] = useState(null);
  const didPrint = useRef(false);

  const statuses = params.get('statuses') || '';
  const projectIds = params.get('project_ids') || '';
  const updatedFrom = params.get('updated_from') || '';
  const updatedTo = params.get('updated_to') || '';

  useEffect(() => {
    const qs = new URLSearchParams({ statuses });
    if (projectIds) qs.set('project_ids', projectIds);
    if (updatedFrom) qs.set('updated_from', updatedFrom);
    if (updatedTo) qs.set('updated_to', updatedTo);
    fetch(`/api/export/tickets?${qs}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then(data => setTickets(groupSort(data)))
      .catch(() => setError('Failed to load tickets. Are you signed in?'));
  }, [statuses, projectIds, updatedFrom, updatedTo]);

  useEffect(() => {
    if (tickets && !didPrint.current) {
      didPrint.current = true;
      setTimeout(() => window.print(), 800);
    }
  }, [tickets]);

  const siteName = branding.site_name || 'Punchlist';
  const primaryColor = branding.primary_color || '#1e40af';

  if (error) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif', color: '#dc2626' }}>{error}</div>;
  }

  if (!tickets) {
    return <div style={{ padding: 40, fontFamily: 'sans-serif', color: '#6b7280' }}>Loading export…</div>;
  }

  const blocked = tickets.filter(t => t.blocker_type);
  const active = tickets.filter(t => !t.blocker_type && t.internal_status !== 'Closed');
  const closed = tickets.filter(t => !t.blocker_type && t.internal_status === 'Closed');

  const exportedStatuses = statuses.split(',').filter(Boolean).join(', ');

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, sans-serif', maxWidth: '860px', margin: '0 auto', padding: '24px 32px', color: '#111827' }}>
      <style>{`
        @media print {
          @page { margin: 15mm 12mm; size: A4; }
          .no-print { display: none !important; }
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>

      {/* Print button — hidden when printing */}
      <div className="no-print" style={{ marginBottom: '20px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button
          onClick={() => window.print()}
          style={{
            background: primaryColor, color: '#fff', border: 'none', borderRadius: '6px',
            padding: '8px 18px', fontSize: '14px', fontWeight: 600, cursor: 'pointer',
          }}
        >
          Print / Save as PDF
        </button>
        <button
          onClick={() => window.close()}
          style={{
            background: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px',
            padding: '8px 18px', fontSize: '14px', cursor: 'pointer',
          }}
        >
          Close
        </button>
        <span style={{ fontSize: '13px', color: '#6b7280' }}>{tickets.length} ticket{tickets.length !== 1 ? 's' : ''}</span>
      </div>

      {/* Document header */}
      <div style={{ borderBottom: `3px solid ${primaryColor}`, paddingBottom: '16px', marginBottom: '8px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            {branding.logo_url && (
              <img
                src={branding.logo_url}
                alt="Logo"
                style={{
                  height: '36px', objectFit: 'contain', marginBottom: '6px',
                  filter: branding.logo_on_dark ? 'invert(1) hue-rotate(180deg)' : 'none',
                }}
              />
            )}
            <div style={{ fontSize: '20px', fontWeight: 700, color: primaryColor }}>{siteName}</div>
            <div style={{ fontSize: '13px', color: '#6b7280' }}>Issue Export Report</div>
          </div>
          <div style={{ textAlign: 'right', fontSize: '11px', color: '#6b7280' }}>
            <div>Generated: {new Date().toLocaleString()}</div>
            <div>Statuses: {exportedStatuses}</div>
            <div>Total tickets: {tickets.length}</div>
          </div>
        </div>
      </div>

      {blocked.length > 0 && (
        <>
          <GroupHeading label={`Blocked (${blocked.length})`} />
          {blocked.map(t => <TicketCard key={t.id} ticket={t} />)}
        </>
      )}

      {active.length > 0 && (
        <>
          <GroupHeading label={`Active (${active.length})`} />
          {active.map(t => <TicketCard key={t.id} ticket={t} />)}
        </>
      )}

      {closed.length > 0 && (
        <>
          <GroupHeading label={`Closed (${closed.length})`} />
          {closed.map(t => <TicketCard key={t.id} ticket={t} />)}
        </>
      )}

      {tickets.length === 0 && (
        <div style={{ textAlign: 'center', padding: '48px', color: '#9ca3af', fontSize: '14px' }}>
          No tickets matched the selected statuses.
        </div>
      )}

      {branding.show_powered_by && (
        <div style={{ marginTop: '32px', paddingTop: '12px', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '10px', color: '#9ca3af' }}>
          <span>Powered by</span>
          <a href="https://hearnetech.com/apps" target="_blank" rel="noopener noreferrer">
            <img
              src="/hearne-logo.png"
              alt="Hearne Technologies"
              style={{ height: '14px', width: 'auto', objectFit: 'contain' }}
            />
          </a>
        </div>
      )}
    </div>
  );
}
