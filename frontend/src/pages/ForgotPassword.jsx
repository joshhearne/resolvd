import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await fetch('/auth/password/forgot', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setSubmitted(true);
    } catch (err) {
      toast.error('Request failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-sm w-full mx-4">
        <h1 className="text-xl font-semibold text-gray-900 mb-3">Reset password</h1>
        {submitted ? (
          <p className="text-sm text-gray-600">
            If an account with that email exists and uses password sign-in, a reset link has been sent.
          </p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
            />
            <button type="submit" disabled={busy}
                    className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-md py-2">
              {busy ? 'Sending…' : 'Send reset link'}
            </button>
          </form>
        )}
        <div className="mt-4 text-center">
          <Link to="/login" className="text-xs text-blue-600 hover:underline">Back to sign in</Link>
        </div>
      </div>
    </div>
  );
}
