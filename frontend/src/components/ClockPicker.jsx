import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Clock-face time picker, modelled on Android's Material dialog: tap or
// drag around the dial for the hour, then the minutes, flip AM/PM, or
// tap the keyboard icon to type it.
//
// Minutes: with snap="five" (the default, a per-user preference) a tap
// lands on the nearest 5 — tap 3 then near the 15 for 3:15. Holding a
// finger on the dial (~⅓ s) switches to single minutes for that press;
// tick marks appear and the phone buzzes once. snap="exact" always takes
// the exact minute under the finger. Built in-app so every phone and desktop gets the same picker;
// the native <input type="time"> only shows a dial on Android — iOS
// gives scroll wheels.

const SIZE = 256;
const C = SIZE / 2;
const R_LABEL = 100;
const HOLD_MS = 350;

function polar(index, steps, r = R_LABEL) {
  const a = (index / steps) * 2 * Math.PI - Math.PI / 2;
  return { x: C + r * Math.cos(a), y: C + r * Math.sin(a) };
}

export default function ClockPicker({ hours, minutes, snap = "five", onConfirm, onCancel }) {
  const [h12, setH12] = useState(hours % 12 || 12);
  const [m, setM] = useState(minutes);
  const [pm, setPm] = useState(hours >= 12);
  const [mode, setMode] = useState("hour");
  const [typing, setTyping] = useState(false);
  const [fine, setFine] = useState(false);
  const dragging = useRef(false);
  const fineRef = useRef(false);
  const holdTimer = useRef(null);
  const lastPoint = useRef(null);
  const svgRef = useRef(null);

  useEffect(() => () => clearTimeout(holdTimer.current), []);

  function pick({ clientX, clientY }) {
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * SIZE - C;
    const y = ((clientY - rect.top) / rect.height) * SIZE - C;
    const deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
    const norm = (deg + 360) % 360;
    if (mode === "hour") setH12(Math.round(norm / 30) % 12 || 12);
    else if (snap === "exact" || fineRef.current) setM(Math.round(norm / 6) % 60);
    else setM((Math.round(norm / 30) * 5) % 60);
  }

  function endHold() {
    clearTimeout(holdTimer.current);
    holdTimer.current = null;
    fineRef.current = false;
    setFine(false);
  }

  const onDown = (e) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    lastPoint.current = { clientX: e.clientX, clientY: e.clientY };
    pick(lastPoint.current);
    if (mode === "minute" && snap !== "exact") {
      holdTimer.current = setTimeout(() => {
        fineRef.current = true;
        setFine(true);
        navigator.vibrate?.(10);
        if (lastPoint.current) pick(lastPoint.current);
      }, HOLD_MS);
    }
  };
  const onMove = (e) => {
    if (!dragging.current) return;
    lastPoint.current = { clientX: e.clientX, clientY: e.clientY };
    pick(lastPoint.current);
  };
  const onUp = () => {
    if (!dragging.current) return;
    dragging.current = false;
    endHold();
    if (mode === "hour") setMode("minute");
  };

  const confirm = () => onConfirm((h12 % 12) + (pm ? 12 : 0), m);

  const hand = mode === "hour" ? polar(h12 % 12, 12) : polar(m, 60);
  const seg = (active) =>
    `px-1 rounded ${active ? "bg-brand/15 text-brand" : "text-fg hover:bg-surface-2"}`;
  const merBtn = (active) =>
    `px-2 py-1 text-sm font-medium border border-border ${active ? "bg-brand/15 text-brand" : "text-fg-muted hover:bg-surface-2"}`;

  return createPortal(
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="bg-surface rounded-xl shadow-xl w-full max-w-xs p-4" role="dialog" aria-label="Pick a time">
        <div className="flex items-center justify-center gap-3 mb-3">
          {typing ? (
            <div className="flex items-center gap-1 text-3xl font-mono">
              <input
                type="number" inputMode="numeric" min="1" max="12" value={h12}
                onChange={(e) => setH12(Math.min(12, Math.max(1, Number(e.target.value) || 1)))}
                className="input w-16 text-2xl text-center py-1" aria-label="Hour"
                autoFocus
              />
              <span>:</span>
              <input
                type="number" inputMode="numeric" min="0" max="59" value={String(m).padStart(2, "0")}
                onChange={(e) => setM(Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
                className="input w-16 text-2xl text-center py-1" aria-label="Minute"
              />
            </div>
          ) : (
            <div className="text-4xl font-mono tabular-nums">
              <button type="button" className={seg(mode === "hour")} onClick={() => setMode("hour")}>
                {String(h12).padStart(2, "0")}
              </button>
              <span className="text-fg-muted">:</span>
              <button type="button" className={seg(mode === "minute")} onClick={() => setMode("minute")}>
                {String(m).padStart(2, "0")}
              </button>
            </div>
          )}
          {/* Either half toggles: one tap flips AM ↔ PM wherever it lands. */}
          <div className="flex flex-col rounded overflow-hidden" role="group" aria-label="AM or PM">
            <button type="button" aria-pressed={!pm} className={`${merBtn(!pm)} rounded-t`} onClick={() => setPm((v) => !v)}>AM</button>
            <button type="button" aria-pressed={pm} className={`${merBtn(pm)} rounded-b -mt-px`} onClick={() => setPm((v) => !v)}>PM</button>
          </div>
        </div>

        {!typing && (
          <svg
            ref={svgRef}
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="w-full max-w-[16rem] mx-auto block touch-none select-none cursor-pointer"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <circle cx={C} cy={C} r={C - 4} className="fill-surface-2" />
            {mode === "minute" && (fine || snap === "exact") &&
              Array.from({ length: 60 }, (_, i) => {
                const a = polar(i, 60, C - 10);
                const b = polar(i, 60, C - (i % 5 ? 14 : 18));
                return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="stroke-current text-fg-dim" strokeWidth="1" />;
              })}
            <line x1={C} y1={C} x2={hand.x} y2={hand.y} className="stroke-brand" strokeWidth="2" />
            <circle cx={C} cy={C} r="4" className="fill-brand" />
            <circle cx={hand.x} cy={hand.y} r="18" className="fill-brand" opacity="0.9" />
            {mode === "hour"
              ? Array.from({ length: 12 }, (_, i) => {
                  const n = i === 0 ? 12 : i;
                  const p = polar(i, 12);
                  const sel = h12 === n;
                  return (
                    <text key={n} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
                      className={sel ? "fill-white" : "fill-current text-fg"} fontSize="15" pointerEvents="none">
                      {n}
                    </text>
                  );
                })
              : Array.from({ length: 12 }, (_, i) => {
                  const v = i * 5;
                  const p = polar(v, 60);
                  const sel = m === v;
                  return (
                    <text key={v} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="central"
                      className={sel ? "fill-white" : "fill-current text-fg"} fontSize="14" pointerEvents="none">
                      {String(v).padStart(2, "0")}
                    </text>
                  );
                })}
            {mode === "minute" && m % 5 !== 0 && (
              <circle cx={hand.x} cy={hand.y} r="3" className="fill-white" pointerEvents="none" />
            )}
          </svg>
        )}

        {!typing && (
          // Always rendered (fixed height) so the dialog never shifts
          // under the finger when the mode or hint changes.
          <p className="text-center text-[11px] text-fg-dim mt-1 h-4">
            {mode === "hour"
              ? "Tap the hour"
              : snap === "exact"
                ? "Tap the exact minute"
                : fine
                  ? "Single minutes — slide to adjust"
                  : "Taps snap to 5 min · hold for single minutes"}
          </p>
        )}

        <div className="flex items-center justify-between mt-3">
          <button
            type="button"
            onClick={() => setTyping((t) => !t)}
            className="text-fg-muted hover:text-fg p-1"
            title={typing ? "Use the clock" : "Type the time"}
            aria-label={typing ? "Use the clock" : "Type the time"}
          >
            {typing ? "🕘" : "⌨"}
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onCancel} className="btn btn-sm btn-secondary">Cancel</button>
            <button type="button" onClick={confirm} className="btn btn-sm btn-primary">OK</button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
