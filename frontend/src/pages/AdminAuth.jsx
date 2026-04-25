import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

const ROLES = ["Admin", "Submitter", "Viewer"];

export default function AdminAuth() {
  const [s, setS] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [smtpPassword, setSmtpPassword] = useState("");
  const [testEmailTo, setTestEmailTo] = useState("");

  useEffect(() => {
    api
      .get("/api/auth-settings")
      .then((data) => {
        setS(data);
        setLoading(false);
      })
      .catch((err) => {
        toast.error(err.message);
        setLoading(false);
      });
  }, []);

  function update(field, value) {
    setS((prev) => ({ ...prev, [field]: value }));
  }

  function toggleRoleEnforced(role) {
    const cur = (s.mfa_required_roles || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const next = cur.includes(role)
      ? cur.filter((r) => r !== role)
      : [...cur, role];
    update("mfa_required_roles", next.join(","));
  }

  async function save() {
    setSaving(true);
    try {
      const patch = { ...s };
      delete patch.smtp_password_set;
      delete patch.id;
      delete patch.updated_at;
      if (smtpPassword) patch.smtp_password = smtpPassword;
      else delete patch.smtp_password;
      const updated = await api.patch("/api/auth-settings", patch);
      setS(updated);
      setSmtpPassword("");
      toast.success("Settings saved");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function testEmail() {
    if (!testEmailTo) return;
    try {
      await api.post("/api/auth-settings/test-email", { to: testEmailTo });
      toast.success("Test email sent (check inbox)");
    } catch (err) {
      toast.error(err.message);
    }
  }

  if (loading)
    return <div className="text-fg-dim py-12 text-center">Loading...</div>;
  if (!s)
    return (
      <div className="text-red-600 dark:text-red-400">
        Failed to load auth settings
      </div>
    );

  const enforced = (s.mfa_required_roles || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <h1 className="text-xl font-semibold text-fg">Authentication Settings</h1>

      <Section title="Sign-in providers">
        <Toggle
          label="Microsoft Entra ID / M365"
          checked={s.entra_enabled}
          onChange={(v) => update("entra_enabled", v)}
        />
        {s.entra_enabled && (
          <Toggle
            indent
            label="Allow personal Microsoft accounts"
            checked={s.entra_allow_personal}
            onChange={(v) => update("entra_allow_personal", v)}
            hint="Switches tenant to 'common'. Requires app registration to allow multi-tenant + personal."
          />
        )}
        <Toggle
          label="Google (Workspace or consumer)"
          checked={s.google_enabled}
          onChange={(v) => update("google_enabled", v)}
        />
        {s.google_enabled && (
          <>
            <Field
              indent
              label="Workspace domain (hd)"
              value={s.google_workspace_domain || ""}
              onChange={(v) => update("google_workspace_domain", v || null)}
              hint="Restrict to one Google Workspace domain. Leave blank to allow any."
            />
            <Toggle
              indent
              label="Also allow consumer (gmail.com) accounts"
              checked={s.google_allow_consumer}
              onChange={(v) => update("google_allow_consumer", v)}
              hint="When set with a workspace domain, accounts outside that domain are also accepted."
            />
          </>
        )}
        <Toggle
          label="Local username/password"
          checked={s.local_enabled}
          onChange={(v) => update("local_enabled", v)}
        />
      </Section>

      <Section title="Multi-factor authentication">
        <p className="text-xs text-fg-muted">
          Each user can enable TOTP MFA on their own. Enforce it per role to
          require it on sign-in.
        </p>
        <div className="flex gap-2 flex-wrap">
          {ROLES.map((r) => (
            <label
              key={r}
              className={`flex items-center gap-2 text-sm px-3 py-1.5 border rounded cursor-pointer ${enforced.includes(r) ? "bg-brand/10 border-brand/40 text-brand " : "border-border-strong"}`}
            >
              <input
                type="checkbox"
                checked={enforced.includes(r)}
                onChange={() => toggleRoleEnforced(r)}
              />
              Require for {r}
            </label>
          ))}
        </div>
      </Section>

      <Section title="Outbound email">
        <Field
          label="Backend"
          type="select"
          value={s.email_backend}
          onChange={(v) => update("email_backend", v)}
          options={[
            ["graph", "Microsoft Graph (M365)"],
            ["gmail", "Gmail API (Workspace, service account)"],
            ["smtp", "SMTP"],
          ]}
        />

        {s.email_backend === "gmail" && (
          <Field
            label="Send from (Workspace mailbox)"
            value={s.google_mail_from || ""}
            onChange={(v) => update("google_mail_from", v || null)}
            hint="Mailbox the service account impersonates (domain-wide delegation required)."
          />
        )}

        {s.email_backend === "smtp" && (
          <>
            <Field
              label="SMTP host"
              value={s.smtp_host || ""}
              onChange={(v) => update("smtp_host", v || null)}
            />
            <Field
              label="Port"
              type="number"
              value={s.smtp_port || ""}
              onChange={(v) => update("smtp_port", parseInt(v, 10) || null)}
            />
            <Field
              label="Username"
              value={s.smtp_user || ""}
              onChange={(v) => update("smtp_user", v || null)}
            />
            <Field
              label={`Password ${s.smtp_password_set ? "(set — leave blank to keep)" : ""}`}
              type="password"
              value={smtpPassword}
              onChange={setSmtpPassword}
            />
            <Toggle
              label="Use TLS (port 465 implicit; otherwise STARTTLS)"
              checked={s.smtp_secure}
              onChange={(v) => update("smtp_secure", v)}
            />
            <Field
              label="From address"
              value={s.smtp_from || ""}
              onChange={(v) => update("smtp_from", v || null)}
            />
          </>
        )}

        <div className="flex gap-2 items-center pt-2">
          <input
            type="email"
            placeholder="test@example.com"
            value={testEmailTo}
            onChange={(e) => setTestEmailTo(e.target.value)}
            className="border border-border-strong rounded px-3 py-1.5 text-sm flex-1"
          />
          <button
            onClick={testEmail}
            className="bg-surface-2 hover:bg-surface-2 px-3 py-1.5 rounded text-sm"
          >
            Send test email
          </button>
        </div>
      </Section>

      <Section title="Invites">
        <Field
          label="Invite link TTL (hours)"
          type="number"
          value={s.invite_ttl_hours}
          onChange={(v) => update("invite_ttl_hours", parseInt(v, 10) || 168)}
        />
      </Section>

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving}
          className="bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm font-medium px-4 py-2 rounded"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
      <h2 className="text-sm font-semibold text-fg">{title}</h2>
      {children}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint, indent }) {
  return (
    <label className={`flex items-start gap-2 text-sm ${indent ? "ml-6" : ""}`}>
      <input
        type="checkbox"
        className="mt-0.5"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div>
        <div>{label}</div>
        {hint && <div className="text-xs text-fg-muted">{hint}</div>}
      </div>
    </label>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  hint,
  options,
  indent,
}) {
  return (
    <div className={`space-y-1 ${indent ? "ml-6" : ""}`}>
      <label className="block text-xs font-medium text-fg">{label}</label>
      {options ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-border-strong rounded px-3 py-1.5 text-sm"
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={type}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full border border-border-strong rounded px-3 py-1.5 text-sm"
        />
      )}
      {hint && <p className="text-xs text-fg-muted">{hint}</p>}
    </div>
  );
}
