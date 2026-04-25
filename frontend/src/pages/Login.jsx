import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../context/BrandingContext';

export default function Login() {
  const { loginEntra, loginGoogle, loginLocal, bootstrapLocal, methods, pendingMfa } = useAuth();
  const { branding } = useBranding();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [setupDisplayName, setSetupDisplayName] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');

  useEffect(() => {
    const err = params.get('error');
    if (err) toast.error(err);
  }, [params]);

  useEffect(() => {
    if (pendingMfa) navigate('/mfa-challenge', { replace: true });
  }, [pendingMfa, navigate]);

  const anySso = methods.entra || methods.google;

  async function handleLocalSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await loginLocal(email, password);
      if (result.pendingMfa) navigate('/mfa-challenge');
      else navigate('/');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleBootstrapSubmit(e) {
    e.preventDefault();
    if (password !== setupConfirm) {
      toast.error('Passwords do not match');
      return;
    }
    setSubmitting(true);
    try {
      await bootstrapLocal({ email, password, displayName: setupDisplayName });
      toast.success('Admin account created');
      navigate('/');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  if (methods.bootstrap && methods.local) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-sm w-full mx-4">
          <div className="mb-6 text-center">
            {branding.logo_url && (
              <img
                src={branding.logo_url}
                alt="Logo"
                className="h-14 w-auto object-contain mx-auto mb-3"
                style={{ filter: branding.logo_on_dark ? 'invert(1) hue-rotate(180deg)' : 'none' }}
              />
            )}
            <h1 className="text-2xl font-bold text-gray-900">Welcome</h1>
            <p className="text-sm text-gray-500 mt-1">Create the first administrator account</p>
          </div>
          <form onSubmit={handleBootstrapSubmit} className="space-y-3">
            <input
              type="text"
              autoComplete="name"
              placeholder="Display name (optional)"
              value={setupDisplayName}
              onChange={e => setSetupDisplayName(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="email"
              required
              autoComplete="username"
              placeholder="Admin email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="password"
              required
              autoComplete="new-password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="password"
              required
              autoComplete="new-password"
              placeholder="Confirm password"
              value={setupConfirm}
              onChange={e => setSetupConfirm(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-500">
              At least 12 characters, with uppercase, lowercase, and a digit.
            </p>
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-md py-2"
            >
              {submitting ? 'Creating…' : 'Create admin account'}
            </button>
          </form>
        </div>
        {branding.show_powered_by && (
          <div className="mt-6 flex items-center gap-2 text-xs text-gray-400">
            <span>Powered by</span>
            <a href="https://hearnetech.com/apps" target="_blank" rel="noopener noreferrer">
              <img
                src="/hearne-logo.png"
                alt="Hearne Technologies"
                className="h-4 w-auto object-contain"
              />
            </a>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-sm w-full mx-4">
        <div className="mb-6 text-center">
          {branding.logo_url && (
            <img
              src={branding.logo_url}
              alt="Logo"
              className="h-14 w-auto object-contain mx-auto mb-3"
              style={{ filter: branding.logo_on_dark ? 'invert(1) hue-rotate(180deg)' : 'none' }}
            />
          )}
          <h1 className="text-2xl font-bold text-gray-900">{branding.site_name || 'Punchlist'}</h1>
          <p className="text-sm text-gray-500 mt-1">{branding.tagline || 'Sign in to continue'}</p>
        </div>

        {methods.bootstrap && (
          <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
            <strong>First-time setup:</strong> the first user to sign in (any method) becomes Admin.
          </div>
        )}

        {methods.entra && (
          <button
            onClick={loginEntra}
            className="w-full flex items-center justify-center gap-2 border border-gray-300 rounded-md py-2 px-4 text-sm font-medium hover:bg-gray-50 mb-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="10" height="10" fill="#F25022"/>
              <rect x="11" width="10" height="10" fill="#7FBA00"/>
              <rect y="11" width="10" height="10" fill="#00A4EF"/>
              <rect x="11" y="11" width="10" height="10" fill="#FFB900"/>
            </svg>
            Sign in with Microsoft
          </button>
        )}

        {methods.google && (
          <button
            onClick={loginGoogle}
            className="w-full flex items-center justify-center gap-2 border border-gray-300 rounded-md py-2 px-4 text-sm font-medium hover:bg-gray-50 mb-2"
          >
            <svg className="w-4 h-4" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
              <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" fill="#4285F4"/>
              <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
              <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
              <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>
        )}

        {anySso && methods.local && (
          <div className="my-4 flex items-center gap-3 text-xs text-gray-400">
            <span className="flex-1 border-t border-gray-200" />
            <span>or</span>
            <span className="flex-1 border-t border-gray-200" />
          </div>
        )}

        {methods.local && (
          <form onSubmit={handleLocalSubmit} className="space-y-3">
            <input
              type="email"
              required
              autoComplete="username"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="password"
              required
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="submit"
              disabled={submitting}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:opacity-60 text-white text-sm font-medium rounded-md py-2"
            >
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
            <div className="text-center">
              <Link to="/forgot-password" className="text-xs text-blue-600 hover:underline">
                Forgot password?
              </Link>
            </div>
          </form>
        )}

        {!methods.entra && !methods.google && !methods.local && (
          <p className="text-sm text-gray-500 text-center">No login methods are enabled. Contact your administrator.</p>
        )}
      </div>
      {branding.show_powered_by && (
        <div className="mt-6 flex items-center gap-2 text-xs text-gray-400">
          <span>Powered by</span>
          <a href="https://hearnetech.com/apps" target="_blank" rel="noopener noreferrer">
            <img
              src="/hearne-logo.png"
              alt="Hearne Technologies"
              className="h-4 w-auto object-contain"
            />
          </a>
        </div>
      )}
    </div>
  );
}
