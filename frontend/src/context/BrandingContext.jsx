import React, { createContext, useContext, useEffect, useState } from "react";
import { setActiveLocale } from "../utils/helpers";
import { useAuth } from "./AuthContext";

const BrandingContext = createContext({});

function hexToRgbTriplet(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || "");
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return `${(v >> 16) & 255} ${(v >> 8) & 255} ${v & 255}`;
}

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState({
    site_name: "Resolvd",
    tagline: "Track every issue. Close every loop.",
    primary_color: "#16a34a",
    show_powered_by: true,
    logo_url: null,
    logo_on_dark: false,
    accent_override_enabled: false,
    logo_designed_for: "light",
  });

  useEffect(() => {
    fetch("/api/branding")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          setBranding((prev) => ({ ...prev, ...data }));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (branding.accent_override_enabled && branding.primary_color) {
      const triplet = hexToRgbTriplet(branding.primary_color);
      if (triplet) {
        root.style.setProperty("--color-brand", triplet);
        root.style.setProperty("--color-brand-bright", triplet);
        root.style.setProperty("--color-brand-dim", triplet);
      }
      root.style.setProperty("--brand-primary", branding.primary_color);
    } else {
      root.style.removeProperty("--color-brand");
      root.style.removeProperty("--color-brand-bright");
      root.style.removeProperty("--color-brand-dim");
      root.style.setProperty(
        "--brand-primary",
        branding.primary_color || "#16a34a",
      );
    }
  }, [branding.accent_override_enabled, branding.primary_color]);

  // Push the configured locale into the helpers module so existing
  // formatDateTime callers automatically honor admin-set styles. Per-user
  // overrides (set in Account Preferences) take precedence over the org
  // branding values when present (non-empty).
  const { user } = useAuth();
  const prefs = user?.preferences || {};
  const dateOverride = prefs.date_style_override;
  const timeOverride = prefs.time_style_override;
  const tzOverride = prefs.timezone_override;
  useEffect(() => {
    setActiveLocale({
      date_style: dateOverride || branding.date_style,
      time_style: timeOverride || branding.time_style,
      timezone: tzOverride || branding.timezone,
    });
  }, [
    branding.date_style, branding.time_style, branding.timezone,
    dateOverride, timeOverride, tzOverride,
  ]);

  return (
    <BrandingContext.Provider value={{ branding, setBranding }}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
