import React, { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';

export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== confirm) return toast.error('Passwords do not match');
    setBusy(true);
    try {
      const res = await fetch('/auth/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Reset failed');
      toast.success('Password reset. You can sign in now.');
      navigate('/login');
    } catch (err) {
      toast.error(err.message);
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100">
      <form onSubmit={handleSubmit} className="bg-white rounded-xl shadow-lg p-8 max-w-sm w-full mx-4 space-y-3">
        <h1 className="text-xl font-semibold text-gray-900">Set a new password</h1>
        <p className="text-xs text-gray-500">Minimum 12 characters with upper, lower, and a digit.</p>
        <input
          type="password"
          required
          autoComplete="new-password"
          placeholder="New password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
        />
        <input
          type="password"
          required
          autoComplete="new-password"
          placeholder="Confirm password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
        />
        <button type="submit" disabled={busy}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-md py-2">
          {busy ? 'Saving…' : 'Reset password'}
        </button>
        <div className="text-center">
          <Link to="/login" className="text-xs text-blue-600 hover:underline">Back to sign in</Link>
        </div>
      </form>
    </div>
  );
}
