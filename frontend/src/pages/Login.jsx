import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useBranding } from '../context/BrandingContext';

export default function Login() {
  const { login } = useAuth();
  const { branding } = useBranding();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gray-100">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-sm w-full mx-4 text-center">
        <div className="mb-6">
          {branding.logo_url && (
            <img
              src={branding.logo_url}
              alt="Logo"
              className="h-14 w-auto object-contain mx-auto mb-3"
              style={{ filter: branding.logo_on_dark ? 'invert(1) hue-rotate(180deg)' : 'none' }}
            />
          )}
          <h1 className="text-2xl font-bold text-gray-900">{branding.site_name || 'MOT Operations'}</h1>
          <p className="text-sm text-gray-500 mt-1">{branding.tagline || 'Internal project & issue tracking'}</p>
        </div>
        <button onClick={login} className="btn-primary btn w-full justify-center gap-2">
          <svg className="w-5 h-5" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect width="10" height="10" fill="#F25022"/>
            <rect x="11" width="10" height="10" fill="#7FBA00"/>
            <rect y="11" width="10" height="10" fill="#00A4EF"/>
            <rect x="11" y="11" width="10" height="10" fill="#FFB900"/>
          </svg>
          Sign in with Microsoft 365
        </button>
        <p className="text-xs text-gray-400 mt-4">Use your @motorhomesoftexas.com account</p>
      </div>
      {branding.show_powered_by && (
        <p className="mt-6 text-xs text-gray-400">
          Powered by <span className="font-medium text-gray-500">Hearne Technologies</span>
        </p>
      )}
    </div>
  );
}
