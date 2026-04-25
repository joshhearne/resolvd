import React, { useState } from "react";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch("/auth/password/forgot", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      setSubmitted(true);
    } catch (err) {
      toast.error("Request failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2">
      <div className="bg-surface rounded-xl shadow-lg p-8 max-w-sm w-full mx-4">
        <h1 className="text-xl font-semibold text-fg mb-3">Reset password</h1>
        {submitted ? (
          <p className="text-sm text-fg-muted">
            If an account with that email exists and uses password sign-in, a
            reset link has been sent.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm"
            />
            <button
              type="submit"
              disabled={busy}
              className="w-full bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm font-medium rounded-md py-2"
            >
              {busy ? "Sending…" : "Send reset link"}
            </button>
          </form>
        )}
        <div className="mt-4 text-center">
          <Link to="/login" className="text-xs text-brand hover:underline">
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
