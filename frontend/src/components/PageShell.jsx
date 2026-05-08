import React from "react";

// Width-variant container for top-level pages. Layout.jsx <main> no longer
// caps width — pages opt into a max-width via this shell.
//   wide     — full minus side padding (tables, dashboards, lists)
//   standard — max-w-5xl   (ticket/project detail, content+aside)
//   narrow   — max-w-3xl   (settings forms, single-column reading)
const VARIANTS = {
  wide: "w-full",
  standard: "max-w-5xl mx-auto",
  narrow: "max-w-3xl mx-auto",
};

export default function PageShell({
  variant = "standard",
  className = "",
  children,
}) {
  const cls = VARIANTS[variant] || VARIANTS.standard;
  return <div className={`${cls} ${className}`}>{children}</div>;
}
