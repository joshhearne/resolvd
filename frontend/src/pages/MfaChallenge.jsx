import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";

export default function MfaChallenge() {
  const { submitMfa } = useAuth();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await submitMfa({
        token: useRecovery ? null : token,
        recoveryCode: useRecovery ? recoveryCode : null,
      });
      navigate("/");
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2">
      <form
        onSubmit={handleSubmit}
        className="bg-surface rounded-xl shadow-lg p-8 max-w-sm w-full mx-4 space-y-4"
      >
        <h1 className="text-xl font-semibold text-fg">
          Two-factor authentication
        </h1>
        <p className="text-sm text-fg-muted">
          {useRecovery
            ? "Enter one of your recovery codes."
            : "Open your authenticator app and enter the 6-digit code."}
        </p>
        {useRecovery ? (
          <input
            autoFocus
            value={recoveryCode}
            onChange={(e) => setRecoveryCode(e.target.value)}
            placeholder="Recovery code"
            className="w-full border border-border-strong rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
        ) : (
          <input
            autoFocus
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="123 456"
            className="w-full border border-border-strong rounded-md px-3 py-2 text-lg tracking-widest text-center focus:outline-none focus:ring-1 focus:ring-brand/40"
          />
        )}
        <button
          type="submit"
          disabled={submitting}
          className="w-full bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm font-medium rounded-md py-2"
        >
          {submitting ? "Verifying…" : "Verify"}
        </button>
        <button
          type="button"
          onClick={() => setUseRecovery((v) => !v)}
          className="w-full text-xs text-brand hover:underline"
        >
          {useRecovery
            ? "Use authenticator app instead"
            : "Use a recovery code"}
        </button>
      </form>
    </div>
  );
}
