import React, { useState } from "react";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";
import { api } from "../utils/api";

export default function MfaSetup() {
  const { user, setUser } = useAuth();
  const [step, setStep] = useState("idle"); // idle, enrolling, codes
  const [qr, setQr] = useState(null);
  const [token, setToken] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState([]);
  const [busy, setBusy] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableToken, setDisableToken] = useState("");

  async function startSetup() {
    setBusy(true);
    try {
      const data = await api.post("/auth/mfa/setup", {});
      setQr(data);
      setStep("enrolling");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const data = await api.post("/auth/mfa/confirm", { token });
      setRecoveryCodes(data.recoveryCodes);
      setStep("codes");
      setUser((u) => ({ ...u, mfaEnabled: true }));
      toast.success("MFA enabled");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function disableMfa() {
    setBusy(true);
    try {
      await api.post("/auth/mfa/disable", {
        password: disablePassword || undefined,
        token: disableToken || undefined,
      });
      setUser((u) => ({ ...u, mfaEnabled: false }));
      toast.success("MFA disabled");
      setDisablePassword("");
      setDisableToken("");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function regenerateCodes() {
    if (!confirm("This invalidates all previous recovery codes. Continue?"))
      return;
    setBusy(true);
    try {
      const data = await api.post("/auth/mfa/recovery/regenerate", {});
      setRecoveryCodes(data.recoveryCodes);
      setStep("codes");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (user?.mfaEnabled && step !== "codes") {
    return (
      <div className="space-y-4 max-w-md">
        <h1 className="text-xl font-semibold text-fg">
          Two-factor authentication
        </h1>
        <p className="text-sm text-green-700 dark:text-green-300 bg-green-50 dark:bg-green-950/40 border border-green-200 dark:border-green-900/50 rounded p-3">
          MFA is enabled on your account.
        </p>

        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-fg">Recovery codes</h2>
          <p className="text-xs text-fg-muted">
            Lost your authenticator? Generate a fresh batch of one-time recovery
            codes.
          </p>
          <button
            onClick={regenerateCodes}
            disabled={busy}
            className="text-sm bg-surface-2 hover:bg-surface-2 px-3 py-1.5 rounded"
          >
            Regenerate recovery codes
          </button>
        </div>

        <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
          <h2 className="text-sm font-semibold text-fg">Disable MFA</h2>
          <p className="text-xs text-fg-muted">
            Provide your current authenticator code, or your password (local
            accounts only).
          </p>
          <input
            type="text"
            placeholder="6-digit code"
            value={disableToken}
            onChange={(e) => setDisableToken(e.target.value)}
            className="w-full border border-border-strong rounded px-3 py-2 text-sm"
          />
          {user.authProvider === "local" && (
            <input
              type="password"
              placeholder="Current password"
              value={disablePassword}
              onChange={(e) => setDisablePassword(e.target.value)}
              className="w-full border border-border-strong rounded px-3 py-2 text-sm"
            />
          )}
          <button
            onClick={disableMfa}
            disabled={busy}
            className="text-sm bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded"
          >
            Disable MFA
          </button>
        </div>
      </div>
    );
  }

  if (step === "codes") {
    return (
      <div className="space-y-4 max-w-md">
        <h1 className="text-xl font-semibold text-fg">
          Save your recovery codes
        </h1>
        <p className="text-sm text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded p-3">
          Store these somewhere safe. Each code can be used once if you lose
          access to your authenticator. They will not be shown again.
        </p>
        <pre className="bg-gray-900 text-green-400 font-mono text-sm p-4 rounded grid grid-cols-2 gap-1">
          {recoveryCodes.map((c) => (
            <span key={c}>{c}</span>
          ))}
        </pre>
        <button
          onClick={() => setStep("idle")}
          className="text-sm bg-brand hover:bg-brand-bright text-brand-fg px-3 py-1.5 rounded"
        >
          I've saved them
        </button>
      </div>
    );
  }

  if (step === "enrolling" && qr) {
    return (
      <form onSubmit={confirmSetup} className="space-y-4 max-w-md">
        <h1 className="text-xl font-semibold text-fg">Set up MFA</h1>
        <p className="text-sm text-fg-muted">
          Scan this QR code with Google Authenticator, Authy, 1Password, or any
          TOTP-compatible app.
        </p>
        <img
          src={qr.qrDataUrl}
          alt="MFA QR code"
          className="border border-border rounded"
        />
        <p className="text-xs text-fg-muted">
          Or enter this secret manually:{" "}
          <code className="bg-surface-2 px-2 py-1 rounded">{qr.secret}</code>
        </p>
        <input
          autoFocus
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={6}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Enter 6-digit code"
          className="w-full border border-border-strong rounded px-3 py-2 text-lg tracking-widest text-center"
        />
        <button
          type="submit"
          disabled={busy}
          className="bg-brand hover:bg-brand-bright text-brand-fg text-sm font-medium px-4 py-2 rounded"
        >
          {busy ? "Verifying…" : "Confirm and enable"}
        </button>
      </form>
    );
  }

  return (
    <div className="space-y-4 max-w-md">
      <h1 className="text-xl font-semibold text-fg">
        Two-factor authentication
      </h1>
      <p className="text-sm text-fg-muted">
        Add a second factor to your account using a TOTP authenticator app
        (Google Authenticator, Authy, 1Password, etc).
      </p>
      <button
        onClick={startSetup}
        disabled={busy}
        className="bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm font-medium px-4 py-2 rounded"
      >
        Begin setup
      </button>
    </div>
  );
}
