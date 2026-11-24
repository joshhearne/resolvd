import React, { useRef, useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Admin → Import: CSV import / export for company locations and users.
// Upload previews every row (create / update / unchanged / error) before
// anything is written; Import applies the whole file or nothing.

const KINDS = {
  locations: {
    title: "Locations",
    blurb: "Sites for your companies, with their main phone line and how extensions are dialled. Import these before users so people can be placed at a location.",
    columns: [
      ["company", "Required. Company name, exactly as under Admin → Companies (the company must exist)."],
      ["name", "Required. Location name."],
      ["code", "Short code (HQ, EAST). Used to match an existing location, and by users' location column."],
      ["address", "Street address."],
      ["timezone", "IANA time zone, e.g. America/Chicago."],
      ["phone", "Main phone line."],
      ["use_extensions", "yes / no: extensions are dialled after this location's main line."],
      ["primary", "yes / no: the company's primary site (one per company)."],
      ["extensions_via", "For a location with use_extensions = no: code or name of another location of the same company whose main line reaches the same extensions. Empty = extensions here are internal use only."],
    ],
    match: "Rows match an existing location of the same company by code, else by name; anything else is added.",
  },
  users: {
    title: "Users",
    blurb: "People for the CRM side: their company, location, job title and phone numbers. One row per person per company.",
    columns: [
      ["email", "Required. Matches an existing user, or creates one."],
      ["name", "Display name. Microsoft / Google accounts take their name from sign-in instead."],
      ["role", "New users only: Admin, Manager, Tech, Submitter, Viewer or Support. Default Viewer. Existing users keep their role."],
      ["sign_in", "New users only: microsoft, google or local. Default: your first enabled SSO option, else local."],
      ["send_invite", "yes / no. yes emails an invite: local users set a password from it; Microsoft / Google users get a sign-in link. Default no."],
      ["company", "Company name (must exist). Adds the person to it."],
      ["location", "Code or name of one of that company's locations."],
      ["job_title", "Their job title at that company."],
      ["extension", "Digits only."],
      ["direct", "Direct line (DID)."],
      ["mobile", "Mobile number."],
    ],
    match:
      "New users are created as invited. Microsoft / Google users become active the first time they sign in; local users once they accept the invite (send one now, or later from Admin → Users). A person on several rows (one per company) gets each membership; later rows' empty cells don't clear what an earlier row set.",
  },
};

const BADGE = {
  create: "bg-green-500/15 text-green-700 dark:text-green-300",
  update: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  unchanged: "bg-surface-2 text-fg-muted",
  error: "bg-red-500/15 text-red-700 dark:text-red-300",
};
const LABEL = { create: "Add", update: "Update", unchanged: "No change", error: "Error" };

function ImportCard({ kind }) {
  const k = KINDS[kind];
  const fileRef = useRef(null);
  const [file, setFile] = useState(null); // { name, text }
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [showCols, setShowCols] = useState(false);

  async function preview(f) {
    setBusy(true);
    setResult(null);
    try {
      setResult(await api.post(`/api/imports/${kind}`, { csv: f.text, apply: false }));
    } catch (e) {
      toast.error(e.message);
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  async function pick(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    if (f.size > 8 * 1024 * 1024) return toast.error("That file is over 8 MB");
    const text = await f.text();
    const next = { name: f.name, text };
    setFile(next);
    preview(next);
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api.post(`/api/imports/${kind}`, { csv: file.text, apply: true });
      setResult(r);
      const s = r.summary;
      let msg = `${s.create} added, ${s.update} updated`;
      if (kind === "users" && r.invites_sent) msg += `, ${r.invites_sent} invite${r.invites_sent === 1 ? "" : "s"} sent`;
      toast.success(msg);
      if (r.invite_failures?.length) toast.error(`Couldn't send ${r.invite_failures.length} invite(s); resend from Admin → Users`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setFile(null);
    setResult(null);
  }

  const s = result?.summary;
  const changes = s ? s.create + s.update : 0;
  const rows = (result?.rows || []).filter((r) => !onlyIssues || r.action === "error" || r.messages.length);

  return (
    <section className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="flex-1 min-w-[16rem]">
          <h2 className="text-base font-semibold text-fg">{k.title}</h2>
          <p className="text-sm text-fg-muted">{k.blurb}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <a href={`/api/imports/${kind}/sample.csv`} className="btn btn-secondary btn-sm">Sample CSV</a>
          <a href={`/api/imports/${kind}/export.csv`} className="btn btn-secondary btn-sm" title={`Download every ${kind === "users" ? "user" : "location"} in this format`}>
            Export current
          </a>
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy} className="btn btn-primary btn-sm">
            Upload CSV…
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={pick} />
        </div>
      </div>

      <div>
        <button type="button" onClick={() => setShowCols((v) => !v)} className="text-xs text-brand hover:underline" aria-expanded={showCols}>
          {showCols ? "Hide columns" : "Columns and rules"}
        </button>
        {showCols && (
          <div className="mt-2 space-y-2">
            <table className="w-full text-xs">
              <tbody className="divide-y divide-border">
                {k.columns.map(([c, d]) => (
                  <tr key={c}>
                    <td className="py-1.5 pr-3 align-top font-mono text-fg whitespace-nowrap">{c}</td>
                    <td className="py-1.5 text-fg-muted">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="text-xs text-fg-muted list-disc pl-5 space-y-1">
              <li>The first row names the columns, in any order. Only the required columns are needed.</li>
              <li>A column left out of the file isn't changed on existing records; an empty cell in a column that's there clears that value.</li>
              <li>{k.match}</li>
              <li>Upload shows what will change. Nothing is saved until you press Import, and nothing is saved if any row has an error.</li>
              <li><b>Export current</b> downloads what's there now in the same format: edit it in a spreadsheet and upload it back.</li>
            </ul>
          </div>
        )}
      </div>

      {file && (
        <div className="rounded-md border border-border bg-surface-2/40 p-3 space-y-3">
          <div className="flex items-center gap-3 flex-wrap text-sm">
            <span className="font-medium text-fg break-all">{file.name}</span>
            {busy && <span className="text-fg-dim">Checking…</span>}
            {s && (
              <span className="flex gap-1.5 flex-wrap">
                {["create", "update", "unchanged", "error"].map((a) => s[a] ? (
                  <span key={a} className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${BADGE[a]}`}>{s[a]} {LABEL[a].toLowerCase()}</span>
                ) : null)}
              </span>
            )}
            <span className="flex-1" />
            {result && !result.applied && (
              <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} />
                Only rows with notes or errors
              </label>
            )}
          </div>

          {result?.applied ? (
            <p className="text-sm text-green-700 dark:text-green-300">
              Imported: {s.create} added, {s.update} updated
              {kind === "users" && <>, {result.invites_sent || 0} invite{result.invites_sent === 1 ? "" : "s"} sent</>}.
              {kind === "users" && <> Review people under <Link to="/admin/companies" className="underline">Companies</Link> or <Link to="/admin/users" className="underline">Users</Link>.</>}
            </p>
          ) : s?.error ? (
            <p className="text-sm text-red-700 dark:text-red-300">Fix the {s.error} row{s.error === 1 ? "" : "s"} with errors in your file and upload it again.</p>
          ) : null}

          {result && rows.length > 0 && (
            <div className="max-h-[28rem] overflow-auto border border-border rounded">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface text-fg-muted">
                  <tr>
                    <th className="text-left font-medium px-2 py-1.5 w-12">Line</th>
                    <th className="text-left font-medium px-2 py-1.5 w-24">Result</th>
                    <th className="text-left font-medium px-2 py-1.5">{kind === "users" ? "Email" : "Company / location"}</th>
                    <th className="text-left font-medium px-2 py-1.5">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((r) => (
                    <tr key={r.line} className={r.action === "error" ? "bg-red-500/5" : ""}>
                      <td className="px-2 py-1.5 tabular-nums text-fg-muted">{r.line}</td>
                      <td className="px-2 py-1.5">
                        <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${BADGE[r.action]}`}>{LABEL[r.action]}</span>
                      </td>
                      <td className="px-2 py-1.5 text-fg break-all">{r.key}</td>
                      <td className="px-2 py-1.5 text-fg-muted">
                        {r.error && <span className="text-red-700 dark:text-red-300">{r.error}</span>}
                        {r.messages.map((m, i) => <div key={i}>{m}</div>)}
                        {r.invite && <div className="text-fg">Invite email{result.applied ? " sent" : " will be sent"}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={reset} className="btn btn-secondary btn-sm">{result?.applied ? "Done" : "Cancel"}</button>
            {result && !result.applied && (
              <button type="button" onClick={apply} disabled={busy || !!s?.error || changes === 0} className="btn btn-primary btn-sm">
                {busy ? "Importing…" : changes ? `Import ${changes} change${changes === 1 ? "" : "s"}` : "Nothing to change"}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default function AdminImport() {
  return (
    <div className="max-w-4xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-fg">Import</h1>
        <p className="text-sm text-fg-muted mt-1 max-w-2xl">
          Bring in locations and users from a spreadsheet saved as CSV. Start from the sample, or export what's here, edit it and upload it back.
          Companies themselves are added under <Link to="/admin/companies" className="text-brand hover:underline">Companies</Link>.
        </p>
      </div>
      <ImportCard kind="locations" />
      <ImportCard kind="users" />
    </div>
  );
}
