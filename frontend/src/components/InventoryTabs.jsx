import React from "react";
import { NavLink } from "react-router-dom";

// Devices / Software / Licenses switch shown at the top of the Inventory pages.
export default function InventoryTabs() {
  const tab = ({ isActive }) =>
    `px-3 py-1.5 text-sm rounded-md transition-colors ${
      isActive ? "bg-surface text-fg shadow-sm font-medium" : "text-fg-muted hover:text-fg"
    }`;
  return (
    <nav aria-label="Inventory views" className="inline-flex rounded-lg bg-surface-2 border border-border p-0.5">
      <NavLink to="/inventory" end className={tab}>Devices</NavLink>
      <NavLink to="/inventory/software" className={tab}>Software</NavLink>
      <NavLink to="/inventory/licenses" className={tab}>Licenses</NavLink>
    </nav>
  );
}
