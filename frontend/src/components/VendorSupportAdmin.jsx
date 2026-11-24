import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Admin → Companies → (vendor) → Support: how to lodge a ticket with this
// vendor's own helpdesk. Channels (email / portal / phone) each carry the
// priority range they're recommended for and notes (call tree, account
// number). Settings decide whether matching new tickets get an agent-only
// note, and narrow which tickets match. Projects: the vendor's own project
// plus any it's allow-listed into (e.g. an MSP's customer projects).

const KINDS = [
  { id: "phone", label: "Phone", placeholder: "(800) 555-0100", valueLabel: "Phone number" },
  { id: "portal", label: "Portal", placeholder: "https://support.vendor.com/new", valueLabel: "Portal link" },
  { id: "email", label: "Email", placeholder: "support@vendor.com", valueLabel: "Support email" },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
const P = [1, 2, 3, 4, 5];
const range = (c) => (c.min_priority === c.max_priority ? `P${c.min_priority}` : `P${c.min_priority}–P${c.max_priority}`);
const input = "w-full bg-surface border border-border rounded px-2 py-1.5 text-sm";

function blank(kind = "phone") {
  return kind === "phone"
    ? { kind, label: "", value: "", notes: "", min_priority: 1, max_priority: 2, enabled: true }
    : { kind, label: "", value: "", notes: "", min_priority: 3, max_priority: 5, enabled: true };
}

function ChannelForm({ initial, onSave, onCancel, busy }) {
  const [f, setF] = useState(initial);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));
  const k = KIND[f.kind];
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); onSave({ ...f, min_priority: Number(f.min_priority), max_priority: Number(f.max_priority) }); }}
      className="p-3 rounded-md bg-surface-2/60 border border-border space-y-3"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Type</span>
          <select className={input} value={f.kind} onChange={set("kind")}>
            {KINDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Name <span className="text-fg-dim font-normal">(optional)</span></span>
          <input className={input} value={f.label || ""} onChange={set("label")} maxLength={80} placeholder="e.g. 24/7 support line" />
        </label>
        <label className="block sm:col-span-2">
          <span className="block text-xs font-medium text-fg mb-1">{k.valueLabel}</span>
          <input className={input} value={f.value} onChange={set("value")} maxLength={500} required placeholder={k.placeholder}
            type={f.kind === "email" ? "email" : f.kind === "portal" ? "url" : "tel"} spellCheck={false} />
          {f.kind === "email" && (
            <span className="block text-[11px] text-fg-muted mt-1">
              Role addresses like support@ are fine here. Resolvd only emails this address when an agent presses Forward on a ticket.
            </span>
          )}
        </label>
        <div className="sm:col-span-2">
          <span className="block text-xs font-medium text-fg mb-1">Recommend for</span>
          <div className="flex items-center gap-2 text-sm">
            <select className="bg-surface border border-border rounded px-2 py-1.5 text-sm" value={f.min_priority} onChange={set("min_priority")} aria-label="Highest priority">
              {P.map((p) => <option key={p} value={p}>P{p}</option>)}
            </select>
            <span className="text-fg-muted">to</span>
            <select className="bg-surface border border-border rounded px-2 py-1.5 text-sm" value={f.max_priority} onChange={set("max_priority")} aria-label="Lowest priority">
              {P.map((p) => <option key={p} value={p}>P{p}</option>)}
            </select>
            <span className="text-[11px] text-fg-muted">P1 is the most urgent. Outside this range it's still listed under other options.</span>
          </div>
        </div>
        <label className="block sm:col-span-2">
          <span className="block text-xs font-medium text-fg mb-1">Notes for agents <span className="text-fg-dim font-normal">(optional)</span></span>
          <textarea className={input} rows={4} value={f.notes || ""} onChange={set("notes")} maxLength={4000}
            placeholder={f.kind === "phone"
              ? "Call tree: press 2 for support, then 1 for outages. Account # 12345, site ID MOT-01. Ask for priority 1 handling."
              : "Account # / customer ID, which product or queue to pick, what to include."} />
        </label>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" checked={f.enabled} onChange={set("enabled")} /> On
        </label>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn btn-secondary btn-sm">Cancel</button>
        <button type="submit" disabled={busy} className="btn btn-primary btn-sm">{busy ? "Saving…" : "Save"}</button>
      </div>
    </form>
  );
}

function Settings({ company, data, onSaved, canEdit }) {
  const s = data.settings;
  const [f, setF] = useState({
    auto_note: s.auto_note !== false,
    match_regex: s.match_regex || "",
    match_field_slug: s.match_field_slug || "",
    match_field_values: (s.match_field_values || []).join(", "),
  });
  const [busy, setBusy] = useState(false);
  const field = data.fields.find((x) => x.slug === f.match_field_slug);
  const options = field && Array.isArray(field.options) ? field.options.map((o) => (typeof o === "string" ? o : o?.value ?? o?.label)).filter(Boolean) : [];

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put(`/api/companies/${company.id}/support/settings`, f);
      toast.success("Saved");
      onSaved();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3">
      <label className="flex items-start gap-2 text-sm text-fg">
        <input type="checkbox" className="mt-0.5" checked={f.auto_note} disabled={!canEdit}
          onChange={(e) => setF((x) => ({ ...x, auto_note: e.target.checked }))} />
        <span>
          Add an agent-only note to matching new tickets with the recommended channels
          <span className="block text-[11px] text-fg-muted">And again if a priority change changes the recommendation. Requesters never see it.</span>
        </span>
      </label>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block sm:col-span-2">
          <span className="block text-xs font-medium text-fg mb-1">Only when title or description matches <span className="text-fg-dim font-normal">(optional regular expression, not case-sensitive)</span></span>
          <input className={`${input} font-mono`} value={f.match_regex} disabled={!canEdit} maxLength={300} spellCheck={false}
            onChange={(e) => setF((x) => ({ ...x, match_regex: e.target.value }))} placeholder="e.g. astra|g2|dms (down|outage|can't log ?in)" />
        </label>
        <label className="block">
          <span className="block text-xs font-medium text-fg mb-1">Only when form field <span className="text-fg-dim font-normal">(optional)</span></span>
          <select className={input} value={f.match_field_slug} disabled={!canEdit}
            onChange={(e) => setF((x) => ({ ...x, match_field_slug: e.target.value, match_field_values: "" }))}>
            <option value="">Any ticket</option>
            {data.fields.map((x) => <option key={x.slug} value={x.slug}>{x.label}</option>)}
          </select>
        </label>
        {f.match_field_slug && (
          <label className="block">
            <span className="block text-xs font-medium text-fg mb-1">is one of <span className="text-fg-dim font-normal">(comma-separated; empty = filled in)</span></span>
            <input className={input} value={f.match_field_values} disabled={!canEdit} list={`vs-opts-${company.id}`}
              onChange={(e) => setF((x) => ({ ...x, match_field_values: e.target.value }))}
              placeholder={options.length ? options.slice(0, 3).join(", ") : "value, another value"} />
            {options.length > 0 && <datalist id={`vs-opts-${company.id}`}>{options.map((o) => <option key={o} value={o} />)}</datalist>}
          </label>
        )}
      </div>
      <p className="text-[11px] text-fg-muted">
        With neither condition set, every ticket in this vendor's projects matches. With both, both must match.
        The Vendor support tab on a ticket lists the channels either way; conditions only decide the automatic note.
      </p>
      {canEdit && (
        <div className="flex justify-end">
          <button type="submit" disabled={busy} className="btn btn-primary btn-sm">{busy ? "Saving…" : "Save settings"}</button>
        </div>
      )}
    </form>
  );
}

function Projects({ company, data, projects, onSaved, canEdit }) {
  const home = data.projects.find((p) => p.is_home);
  const linked = new Set(data.projects.filter((p) => !p.is_home).map((p) => p.id));
  const [busy, setBusy] = useState(false);
  async function toggle(id) {
    const next = new Set(linked);
    if (next.has(id)) next.delete(id); else next.add(id);
    setBusy(true);
    try {
      await api.put(`/api/companies/${company.id}/projects`, { project_ids: [...next] });
      onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }
  const others = projects.filter((p) => p.status === "active" && p.id !== home?.id);
  return (
    <div className="space-y-2">
      <p className="text-sm text-fg">
        {home ? <>Offered on tickets in <b>{home.name}</b>{home.prefix ? ` (#${home.prefix})` : ""}, this vendor's project.</> : "This vendor has no project of its own."}
      </p>
      <p className="text-[11px] text-fg-muted">Also offer it in these projects (for example customer projects that use this vendor):</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {others.map((p) => (
          <label key={p.id} className="flex items-center gap-1.5 text-sm text-fg">
            <input type="checkbox" checked={linked.has(p.id)} disabled={!canEdit || busy} onChange={() => toggle(p.id)} />
            {p.name}{p.prefix ? <span className="text-fg-dim font-mono text-xs">#{p.prefix}</span> : null}
          </label>
        ))}
        {!others.length && <span className="text-xs text-fg-dim italic">No other active projects.</span>}
      </div>
    </div>
  );
}

export default function VendorSupportAdmin({ company, projects = [], canEdit }) {
  const [data, setData] = useState(null);
  const [editing, setEditing] = useState(null); // channel id, or "new"
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setData(await api.get(`/api/companies/${company.id}/support`)); }
    catch (e) { toast.error(e.message); }
  }
  useEffect(() => { setData(null); setEditing(null); load(); }, [company.id]);

  async function save(ch) {
    setBusy(true);
    try {
      if (ch.id) await api.patch(`/api/vendor-support/channels/${ch.id}`, ch);
      else await api.post(`/api/companies/${company.id}/support/channels`, ch);
      toast.success("Saved");
      setEditing(null);
      await load();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(ch) {
    if (!window.confirm(`Remove ${KIND[ch.kind].label.toLowerCase()} ${ch.value}?`)) return;
    try { await api.delete(`/api/vendor-support/channels/${ch.id}`); await load(); }
    catch (e) { toast.error(e.message); }
  }

  if (!data) return <p className="text-sm text-fg-dim">Loading…</p>;
  return (
    <div className="space-y-5">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-fg">How to open a ticket with {company.name}</h3>
          {canEdit && editing !== "new" && (
            <button type="button" onClick={() => setEditing("new")} className="btn btn-secondary btn-sm">+ Add channel</button>
          )}
        </div>
        {editing === "new" && <ChannelForm initial={blank(data.channels.some((c) => c.kind === "phone") ? "email" : "phone")} busy={busy} onSave={save} onCancel={() => setEditing(null)} />}
        {data.channels.length === 0 && editing !== "new" ? (
          <p className="text-sm text-fg-dim italic">
            No channels yet. Add their support line (with the call tree and your account number), portal and support email.
          </p>
        ) : (
          <ul className="divide-y divide-border border border-border rounded-md">
            {data.channels.map((c) => (
              <li key={c.id} className="px-3 py-2">
                {editing === c.id ? (
                  <ChannelForm initial={{ ...c, label: c.label || "", notes: c.notes || "" }} busy={busy} onSave={save} onCancel={() => setEditing(null)} />
                ) : (
                  <div className="flex items-start gap-3 flex-wrap">
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-surface-2 text-fg-muted mt-0.5 w-14 text-center">{KIND[c.kind].label}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-fg break-all">
                        {c.label && <span className="font-medium">{c.label}: </span>}{c.value}
                        <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded bg-brand/10 text-brand whitespace-nowrap">{range(c)}</span>
                        {!c.enabled && <span className="ml-2 text-[11px] text-fg-dim">off</span>}
                      </div>
                      {c.notes && <div className="text-xs text-fg-muted whitespace-pre-wrap mt-0.5">{c.notes}</div>}
                    </div>
                    {canEdit && (
                      <span className="flex gap-3">
                        <button type="button" onClick={() => setEditing(c.id)} className="text-xs text-brand hover:underline">Edit</button>
                        <button type="button" onClick={() => remove(c)} className="text-xs text-red-600 hover:underline">Remove</button>
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-fg">Which tickets</h3>
        <Projects company={company} data={data} projects={projects} onSaved={load} canEdit={canEdit} />
      </section>

      <section className="space-y-2 border-t border-border pt-4">
        <h3 className="text-sm font-semibold text-fg">Automatic note</h3>
        <Settings key={JSON.stringify(data.settings)} company={company} data={data} onSaved={load} canEdit={canEdit} />
      </section>
    </div>
  );
}
