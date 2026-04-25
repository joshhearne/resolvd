import React, { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import toast from "react-hot-toast";
import { useAuth } from "../context/AuthContext";

export default function AcceptInvite() {
  const { token } = useParams();
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [invite, setInvite] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch(`/api/invites/${token}`)
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || "Invite not found");
        return data;
      })
      .then(setInvite)
      .catch((err) => setLoadErr(err.message));
  }, [token]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (invite.intended_provider === "local" && password !== confirm) {
      return toast.error("Passwords do not match");
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/invites/${token}/accept`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, displayName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Accept failed");
      if (data.user) {
        setUser(data.user);
        navigate("/");
      } else if (data.redirectProvider === "entra") {
        window.location.href = "/auth/login";
      } else if (data.redirectProvider === "google") {
        window.location.href = "/auth/google/login";
      } else {
        navigate("/login");
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loadErr) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-2">
        <div className="bg-surface rounded-xl shadow-lg p-8 max-w-sm w-full mx-4 text-center">
          <h1 className="text-lg font-semibold text-fg mb-2">
            Invite unavailable
          </h1>
          <p className="text-sm text-fg-muted">{loadErr}</p>
          <Link
            to="/login"
            className="mt-4 inline-block text-xs text-brand hover:underline"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  if (!invite) {
    return (
      <div className="min-h-screen flex items-center justify-center text-fg-muted text-sm">
        Loading invite…
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-2">
      <form
        onSubmit={handleSubmit}
        className="bg-surface rounded-xl shadow-lg p-8 max-w-sm w-full mx-4 space-y-3"
      >
        <h1 className="text-xl font-semibold text-fg">Accept invitation</h1>
        <p className="text-sm text-fg-muted">
          You've been invited as <strong>{invite.role}</strong>.
        </p>
        <div className="text-xs text-fg-muted">Email: {invite.email}</div>

        <input
          type="text"
          placeholder="Display name (optional)"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full border border-border-strong rounded-md px-3 py-2 text-sm"
        />

        {invite.intended_provider === "local" && (
          <>
            <p className="text-xs text-fg-muted">
              Set a password (min 12 chars, upper/lower/digit).
            </p>
            <input
              type="password"
              required
              autoComplete="new-password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm"
            />
            <input
              type="password"
              required
              autoComplete="new-password"
              placeholder="Confirm password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full border border-border-strong rounded-md px-3 py-2 text-sm"
            />
          </>
        )}

        {invite.intended_provider !== "local" && (
          <p className="text-xs text-fg-muted bg-surface-2 border border-border rounded p-3">
            After accepting, you'll be redirected to sign in with{" "}
            {invite.intended_provider === "entra" ? "Microsoft" : "Google"}.
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full bg-brand hover:bg-brand-bright disabled:opacity-60 text-brand-fg text-sm font-medium rounded-md py-2"
        >
          {busy ? "Accepting…" : "Accept and continue"}
        </button>
      </form>
    </div>
  );
}
