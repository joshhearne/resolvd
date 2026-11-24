import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";
import { appHref } from "../utils/phone";

// Admin → Calling apps: which apps the ticket Contacts tab's call buttons
// can open, the link each one uses, and the organisation default. Users
// pick their own under Account → Preferences → Call with.

const SAMPLE_NUMBER = "+19365550101";
const SAMPLE_EXT = "105";

function preview(app) {
  const r = appHref(app, SAMPLE_NUMBER, null);
  return r?.href || "";
}

// What an extension-only link looks like for a template (SAMPLE_EXT dialled on its own).
function extPreview(tpl) {
  const t = (tpl || "").trim();
  if (!t) return "";
  const out = t.replace(/\{(number|digits|ext)\}/g, SAMPLE_EXT);
  return /\{(number|digits)\}/.test(t) ? out : out + SAMPLE_EXT;
}

function AppRow({ app, onSaved, onDelete }) {
  const [f, setF] = useState({ name: app.name, url_template: app.url_template, ext_template: app.ext_template || "", notes: app.notes || "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = f.name !== app.name || f.url_template !== app.url_template || f.ext_template !== (app.ext_template || "") || f.notes !== (app.notes || "");

  async function patch(body, msg = "Saved") {
    setBusy(true);
    try {
      await api.patch(`/api/calling-apps/${app.id}`, body);
      toast.success(msg);
      await onSaved();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono";
  return (
    <li className="px-3 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-fg">{app.name}</span>
            {app.is_default && <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-brand/15 text-brand">Default</span>}
            {!app.key && <span className="rounded px-1.5 py-0.5 text-[11px] bg-surface-2 text-fg-muted">Custom</span>}
          </div>
          <div className="text-xs text-fg-muted font-mono truncate" title={app.url_template}>{app.url_template}</div>
          {app.notes && <div className="text-xs text-fg-dim">{app.notes}</div>}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted" title="Show this app in Account → Preferences → Call with">
          <input type="checkbox" checked={app.enabled} disabled={busy || app.is_default}
            onChange={(e) => patch({ enabled: e.target.checked }, e.target.checked ? "Turned on" : "Turned off")} />
          On
        </label>
        <label className="flex items-center gap-1.5 text-xs text-fg-muted">
          <input type="radio" name="calling-default" checked={app.is_default} disabled={busy}
            onChange={() => patch({ is_default: true }, `${app.name} is now the default`)} />
          Default
        </label>
        <button type="button" onClick={() => setOpen((v) => !v)} className="text-xs text-brand hover:underline">{open ? "Close" : "Edit"}</button>
        {!app.key && (
          <button type="button" onClick={() => onDelete(app)} disabled={app.is_default} className="text-xs text-red-600 hover:underline disabled:opacity-40">Remove</button>
        )}
      </div>

      {/* Apps with an extension link already dial main line + extension,
          so the extension-only option doesn't apply to them. */}
      {!app.ext_template && (
        <label className="mt-2 flex items-center gap-2 text-sm text-fg flex-wrap">
          <input type="checkbox" checked={!!app.ext_direct} disabled={busy}
            onChange={(e) => patch({ ext_direct: e.target.checked })} />
          Dial internal extensions directly
          <code className="font-mono text-xs text-fg-muted">{extPreview(app.url_template)}</code>
        </label>
      )}

      {open && (
        <form
          onSubmit={(e) => { e.preventDefault(); patch({ name: f.name, url_template: f.url_template, ext_template: f.ext_template || null, notes: f.notes }); }}
          className="mt-3 p-3 rounded-md bg-surface-2/60 border border-border space-y-3"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-medium text-fg mb-1">Name</span>
              <input className={input.replace(" font-mono", "")} value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} maxLength={80} required />
            </label>
            <label className="block">
              <span className="block text-xs font-medium text-fg mb-1">Note for users <span className="text-fg-dim font-normal">(optional)</span></span>
              <input className={input.replace(" font-mono", "")} value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} maxLength={300} />
            </label>
            <label className="block sm:col-span-2">
              <span className="block text-xs font-medium text-fg mb-1">Link or prefix</span>
              <input className={input} value={f.url_template} onChange={(e) => setF((x) => ({ ...x, url_template: e.target.value }))} maxLength={500} required spellCheck={false} />
              <span className="block text-[11px] text-fg-muted mt-1">
                Example: <code className="font-mono break-all">{preview({ url_template: f.url_template })}</code>
              </span>
            </label>
            <label className="block sm:col-span-2">
              <span className="block text-xs font-medium text-fg mb-1">Link with extension <span className="text-fg-dim font-normal">(optional, only if the app can dial a main line then an extension)</span></span>
              <input className={input} value={f.ext_template} onChange={(e) => setF((x) => ({ ...x, ext_template: e.target.value }))} maxLength={500} spellCheck={false} placeholder="e.g. tel:{number},{ext}" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setF({ name: app.name, url_template: app.url_template, ext_template: app.ext_template || "", notes: app.notes || "" }); setOpen(false); }} className="btn btn-secondary btn-sm">Cancel</button>
            <button type="submit" disabled={busy || !dirty} className="btn btn-primary btn-sm">Save</button>
          </div>
        </form>
      )}
    </li>
  );
}

export default function AdminCallingApps() {
  const [apps, setApps] = useState(null);
  const [form, setForm] = useState({ name: "", url_template: "", notes: "", ext_direct: false });
  const [adding, setAdding] = useState(false);

  async function load() {
    try { setApps(await api.get("/api/calling-apps/all")); } catch (e) { toast.error(e.message); setApps([]); }
  }
  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    setAdding(true);
    try {
      await api.post("/api/calling-apps", form);
      setForm({ name: "", url_template: "", notes: "", ext_direct: false });
      toast.success("App added");
      await load();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function remove(app) {
    if (!window.confirm(`Remove ${app.name}? Anyone using it goes back to the default.`)) return;
    try { await api.delete(`/api/calling-apps/${app.id}`); toast.success("Removed"); await load(); }
    catch (e) { toast.error(e.message); }
  }

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-fg">Calling apps</h1>
        <p className="text-sm text-fg-muted mt-1 max-w-2xl">
          The apps the call buttons on a ticket's <b>Contacts</b> tab can open. Turn on the ones your team uses, pick the default,
          and people choose their own under Account → Preferences → Call with.
        </p>
      </div>

      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-fg space-y-1">
        <p><b>Apps other than the phone app can't dial an extension after the main line,</b> so their buttons lead with the direct line and mobile; main line + extension stays available through the phone app.</p>
        <p><b>Dial internal extensions directly</b> adds an <b>Extension</b> button for internal users (members of an internal company) that dials just their extension. Turn it on for an app that shares your office phone system's extensions, like Webex Calling.</p>
        <p><b>A browser can't tell whether an app is installed.</b> If the chosen app isn't on a device, its buttons do nothing, so each one has a small <b>Phone app</b> link underneath. Test a link on one iPhone and one Android before switching everyone over.</p>
      </div>

      <section className="bg-surface border border-border rounded-lg">
        {apps == null ? (
          <p className="p-4 text-sm text-fg-dim">Loading…</p>
        ) : (
          <ul className="divide-y divide-border">
            {apps.map((a) => <AppRow key={a.id} app={a} onSaved={load} onDelete={remove} />)}
          </ul>
        )}
      </section>

      <form onSubmit={add} className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <h2 className="text-base font-semibold text-fg">Add an app</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-fg mb-1">Name</span>
            <input className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm" value={form.name}
              onChange={(e) => setForm((x) => ({ ...x, name: e.target.value }))} maxLength={80} required placeholder="e.g. Acme Voice" />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-fg mb-1">Note for users <span className="text-fg-dim font-normal">(optional)</span></span>
            <input className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm" value={form.notes}
              onChange={(e) => setForm((x) => ({ ...x, notes: e.target.value }))} maxLength={300} />
          </label>
          <label className="block sm:col-span-2">
            <span className="block text-xs font-medium text-fg mb-1">Mobile link or prefix</span>
            <input className="w-full bg-surface border border-border rounded px-2 py-1.5 text-sm font-mono" value={form.url_template}
              onChange={(e) => setForm((x) => ({ ...x, url_template: e.target.value }))} maxLength={500} required spellCheck={false}
              placeholder="e.g. acmecall://  or  acmecall://call?to={number}" />
            <span className="block text-[11px] text-fg-muted mt-1">
              Use <code className="font-mono">{"{number}"}</code> for the number with country code (+19365550101) or{" "}
              <code className="font-mono">{"{digits}"}</code> without the +. A prefix with neither gets the number added to the end.
              {form.url_template && <> Example: <code className="font-mono break-all">{preview({ url_template: form.url_template })}</code></>}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-fg sm:col-span-2">
            <input type="checkbox" checked={form.ext_direct} onChange={(e) => setForm((x) => ({ ...x, ext_direct: e.target.checked }))} />
            Dial internal extensions directly
          </label>
        </div>
        <div className="flex justify-end">
          <button type="submit" disabled={adding} className="btn btn-primary btn-sm">{adding ? "Adding…" : "Add app"}</button>
        </div>
      </form>
    </div>
  );
}
