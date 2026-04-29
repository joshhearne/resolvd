import { useState, useEffect } from "react";
import { api } from "../utils/api";
import toast from "react-hot-toast";

const DEFAULTS = {
  on_status_change: true,
  status_change_statuses: [],
  on_ticket_resolved: true,
  on_ticket_reopened: false,
};

function merge(prefs) {
  return { ...DEFAULTS, ...(prefs || {}) };
}

export default function CompanyNotificationPrefs({ company }) {
  const [prefs, setPrefs] = useState(merge(company.notification_prefs));
  const [statuses, setStatuses] = useState([]);
  const [statusExpanded, setStatusExpanded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get("/api/statuses").then(data => setStatuses(data.internal || [])).catch(() => {});
  }, []);

  async function save(next) {
    setPrefs(next);
    setSaving(true);
    try {
      await api.patch(`/api/companies/${company.id}`, { notification_prefs: next });
    } catch (e) {
      toast.error(e.message || "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function toggle(key) {
    save({ ...prefs, [key]: !prefs[key] });
  }

  function toggleStatus(statusName) {
    const cur = prefs.status_change_statuses || [];
    const next = cur.includes(statusName)
      ? cur.filter(s => s !== statusName)
      : [...cur, statusName];
    save({ ...prefs, status_change_statuses: next });
  }

  const internalStatuses = statuses;
  const allStatuses = prefs.status_change_statuses?.length === 0;

  return (
    <div className="border-t border-border pt-4 mt-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="text-sm font-semibold text-fg">Automated Email Notifications</h4>
        {saving && <span className="text-[11px] text-fg-dim">Saving…</span>}
      </div>
      <p className="text-[11px] text-fg-muted mb-3">
        Controls which automated flows email this company's contacts. Manual actions (Notify Vendor, vendor-visible comments) always send.
      </p>

      <div className="space-y-3">
        {/* Status changes */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={prefs.on_status_change}
              onChange={() => toggle("on_status_change")}
              className="rounded"
            />
            <span className="text-sm text-fg">Internal status changes</span>
          </label>

          {prefs.on_status_change && (
            <div className="ml-6 mt-2">
              <button
                type="button"
                onClick={() => setStatusExpanded(e => !e)}
                className="text-[11px] text-brand hover:underline flex items-center gap-1"
              >
                {statusExpanded ? "▾" : "▸"}
                {allStatuses ? "All statuses" : `${prefs.status_change_statuses.length} selected`}
                {" — click to filter"}
              </button>

              {statusExpanded && (
                <div className="mt-2 grid grid-cols-2 gap-1">
                  <label className="col-span-2 flex items-center gap-2 cursor-pointer text-xs text-fg-muted mb-1">
                    <input
                      type="checkbox"
                      checked={allStatuses}
                      onChange={() => {
                        if (allStatuses) {
                          // Switch to granular — start with all selected so user deselects what they don't want
                          save({ ...prefs, status_change_statuses: internalStatuses.map(s => s.name) });
                        } else {
                          save({ ...prefs, status_change_statuses: [] });
                        }
                      }}
                    />
                    All statuses
                  </label>
                  {internalStatuses.map(s => (
                    <label key={s.id} className={`flex items-center gap-2 cursor-pointer text-xs ${allStatuses ? "text-fg-dim" : "text-fg"}`}>
                      <input
                        type="checkbox"
                        checked={allStatuses || prefs.status_change_statuses.includes(s.name)}
                        disabled={allStatuses}
                        onChange={() => toggleStatus(s.name)}
                      />
                      {s.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Ticket resolved */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={prefs.on_ticket_resolved}
            onChange={() => toggle("on_ticket_resolved")}
            className="rounded"
          />
          <span className="text-sm text-fg">Ticket resolved / closed</span>
        </label>

        {/* Ticket reopened */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={prefs.on_ticket_reopened}
            onChange={() => toggle("on_ticket_reopened")}
            className="rounded"
          />
          <span className="text-sm text-fg">Ticket reopened</span>
        </label>
      </div>

      <p className="text-[11px] text-fg-dim mt-3">
        All notifications are gated on prior vendor contact — no emails sent until Notify Vendor or a vendor-visible comment fires first.
      </p>
    </div>
  );
}
