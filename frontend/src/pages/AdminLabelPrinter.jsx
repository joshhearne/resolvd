import React, { useEffect, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

export default function AdminLabelPrinter() {
  const [cfg, setCfg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [draft, setDraft] = useState({});

  async function load() {
    setLoading(true);
    try {
      const c = await api.get("/api/label-printer");
      setCfg(c);
      setDraft({
        enabled: c?.enabled ?? false,
        host: c?.host || "",
        port: c?.port ?? 9100,
        dpi: c?.dpi ?? 203,
        media_w_dots: c?.media_w_dots ?? 406,
        media_h_dots: c?.media_h_dots ?? 152,
        top_offset_dots: c?.top_offset_dots ?? 15,
        property_line: c?.property_line || "",
      });
    } catch (e) {
      toast.error(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function save() {
    setSaving(true);
    try {
      const c = await api.patch("/api/label-printer", draft);
      setCfg(c);
      toast.success("Saved");
    } catch (e) {
      toast.error(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function printTest() {
    setTesting(true);
    try {
      await api.post("/api/label-printer/test");
      toast.success("Test label sent");
    } catch (e) {
      toast.error(e.message || "Test failed");
    } finally {
      setTesting(false);
    }
  }

  function field(key, label, type = "text", extra = {}) {
    return (
      <label className="text-xs text-fg-muted flex flex-col gap-1">
        {label}
        <input
          type={type}
          value={draft[key] ?? ""}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              [key]: type === "number" ? Number(e.target.value) : e.target.value,
            }))
          }
          className="bg-surface-2 border border-border rounded px-2 py-1 text-sm"
          {...extra}
        />
      </label>
    );
  }

  if (loading) return <div className="text-sm text-fg-dim">Loading…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-fg mb-1">Label printer</h1>
        <p className="text-sm text-fg-muted">
          Zebra (ZPL) printer used for asset and service-request labels. Connects over raw TCP — typically port 9100. Backend container must reach the printer's IP on the LAN.
        </p>
      </div>

      <div className="bg-surface border border-border rounded-lg p-4 space-y-3">
        <label className="flex items-center gap-2 text-sm text-fg">
          <input
            type="checkbox"
            checked={!!draft.enabled}
            onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          />
          Enabled
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {field("host", "Host (IP or DNS)", "text", { placeholder: "10.1.10.39" })}
          {field("port", "Port", "number", { min: 1, max: 65535 })}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          {field("dpi", "DPI", "number", { min: 100, max: 600 })}
          {field("media_w_dots", "Media width (dots)", "number", { min: 1 })}
          {field("media_h_dots", "Media height (dots)", "number", { min: 1 })}
          {field("top_offset_dots", "Top offset (dots)", "number", { min: -120, max: 120 })}
        </div>
        <p className="text-xs text-fg-dim">
          2"×0.75" @ 203dpi = 406×152 dots. 300dpi = 600×226. Top offset accepts -120 to +120 — positive shifts the label down on the media, negative shifts up. Use the sign that pulls the print onto your label stock.
        </p>

        {field("property_line", "Property line (asset label footer)", "text", {
          placeholder: "Property of: Motorhomes of Texas",
        })}
        <p className="text-xs text-fg-dim">
          Optional. Prints at the bottom of every asset label. Leave blank to omit.
        </p>

        <div className="flex gap-2 pt-2">
          <button onClick={save} disabled={saving} className="btn btn-primary btn-sm disabled:opacity-50">
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={printTest}
            disabled={testing || !cfg?.enabled || !cfg?.host}
            className="btn btn-secondary btn-sm disabled:opacity-50"
            title={!cfg?.enabled ? "Enable + save first" : !cfg?.host ? "Set a host first" : "Send a calibration label"}
          >
            {testing ? "Sending…" : "Print test label"}
          </button>
        </div>
        {cfg?.updated_at && (
          <p className="text-[11px] text-fg-dim">Last saved {new Date(cfg.updated_at).toLocaleString()}.</p>
        )}
      </div>
    </div>
  );
}
