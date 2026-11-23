import React, { createContext, useContext, useEffect, useState } from "react";
import { setActiveLocale } from "../utils/helpers";
import { brandCss } from "../utils/brandColors";
import { useAuth } from "./AuthContext";

const BrandingContext = createContext({});

export function BrandingProvider({ children }) {
  const [branding, setBranding] = useState({
    site_name: "Resolvd",
    tagline: "Track every issue. Close every loop.",
    primary_color: "#16a34a",
    show_powered_by: true,
    logo_url: null,
    logo_on_dark: false,
    accent_override_enabled: false,
    phonetic_readback_enabled: true,
    logo_designed_for: "light",
    accent_dark: null,
    accent_fg_light: null,
    accent_fg_dark: null,
    logo_dark_url: null,
    favicon_dark_url: null,
    footer_name: "",
    footer_url: "",
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

  // Per-mode accent: inject `:root` (light) and `.dark` rules so each mode
  // gets its own accent and its own text-on-accent color.
  useEffect(() => {
    let el = document.getElementById("brand-vars");
    const css = brandCss(branding);
    if (!css) {
      el?.remove();
      document.documentElement.style.setProperty(
        "--brand-primary",
        branding.primary_color || "#16a34a",
      );
      return;
    }
    document.documentElement.style.removeProperty("--brand-primary");
    if (!el) {
      el = document.createElement("style");
      el.id = "brand-vars";
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, [
    branding.accent_override_enabled, branding.primary_color,
    branding.accent_dark, branding.accent_fg_light, branding.accent_fg_dark,
  ]);

  // Tab icon follows the browser's own color scheme (the tab strip is drawn
  // by the browser, not by the app theme). Falls back to the light icon on
  // the server when no dark one is uploaded.
  useEffect(() => {
    const link = document.querySelector('link[rel="icon"][data-brand]');
    if (!link) return undefined;
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark = mq?.matches && branding.favicon_dark_url;
      link.href = dark ? branding.favicon_dark_url : branding.favicon_url || "/api/branding/favicon";
    };
    apply();
    mq?.addEventListener?.("change", apply);
    return () => mq?.removeEventListener?.("change", apply);
  }, [branding.favicon_url, branding.favicon_dark_url]);

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
