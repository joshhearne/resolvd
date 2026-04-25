import React, { createContext, useContext, useEffect, useState } from 'react';

const BrandingContext = createContext({});

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState({
    site_name: 'Punchlist',
    tagline: 'Track every issue. Close every loop.',
    primary_color: '#1e40af',
    show_powered_by: true,
    logo_url: null,
  });

  useEffect(() => {
    fetch('/api/branding')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setBranding(prev => ({ ...prev, ...data }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (branding.primary_color) {
      document.documentElement.style.setProperty('--brand-primary', branding.primary_color);
    }
  }, [branding.primary_color]);

  return (
    <BrandingContext.Provider value={{ branding, setBranding }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
