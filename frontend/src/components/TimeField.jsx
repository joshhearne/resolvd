import { useState } from "react";
import ClockPicker from "./ClockPicker";
import { useAuth } from "../context/AuthContext";
import { formatTime, isPm, parseTimeOfDay, withTimeOfDay } from "../utils/timeEntry";

// Time-of-day field for time entries. Type "830", "8:30", "8:30p"…;
// press a or p (any case) to flip AM/PM; ↑/↓ nudge a minute (Shift: 15).
// The clock button opens a dial picker; on touch screens tapping the
// field opens the dial straight away (it has its own type-it mode).

const COARSE = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

export default function TimeField({ value, onChange, label, highlight = false }) {
  const [text, setText] = useState(formatTime(value));
  const [focused, setFocused] = useState(false);
  const [bad, setBad] = useState(false);
  const [dial, setDial] = useState(false);
  // Account Preferences → "Clock picker minutes". Null outside the auth
  // provider (e.g. isolated renders) → default snapping.
  const snap = useAuth()?.user?.preferences?.clock_minute_snap === "exact" ? "exact" : "five";

  function commit(raw) {
    const t = parseTimeOfDay(raw, isPm(value));
    if (!t) {
      setBad(true);
      setText(formatTime(value));
      return;
    }
    setBad(false);
    const next = withTimeOfDay(value, t.h, t.m);
    if (next.getTime() !== new Date(value).getTime()) onChange(next);
    setText(formatTime(next));
  }

  function onKeyDown(e) {
    const k = e.key.toLowerCase();
    if ((k === "a" || k === "p") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      // Flip meridiem on whatever is typed so far (or the current value).
      const t = parseTimeOfDay(text.replace(/\s*(am|pm|a|p)\s*$/i, ""), isPm(value)) ||
        { h: new Date(value).getHours(), m: new Date(value).getMinutes() };
      const h = (t.h % 12) + (k === "p" ? 12 : 0);
      const next = withTimeOfDay(value, h, t.m);
      onChange(next);
      setText(formatTime(next));
      setBad(false);
    } else if (k === "m" && /[ap]m$/i.test(text.trim())) {
      // "am"/"pm" typed out in full: the a/p already flipped it.
      e.preventDefault();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const step = (e.shiftKey ? 15 : 1) * (e.key === "ArrowUp" ? 1 : -1);
      const next = new Date(new Date(value).getTime() + step * 60000);
      onChange(next);
      setText(formatTime(next));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(text);
    }
  }

  const d = new Date(value);
  return (
    <span className="inline-flex items-center gap-1">
      <input
        type="text"
        inputMode={COARSE ? "none" : "text"}
        readOnly={COARSE}
        value={focused ? text : formatTime(value)}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => {
          setText(formatTime(value));
          setFocused(true);
          if (!COARSE) { const el = e.target; requestAnimationFrame(() => el.select()); }
        }}
        onBlur={() => { setFocused(false); commit(text); }}
        onClick={() => { if (COARSE) setDial(true); }}
        onKeyDown={onKeyDown}
        aria-label={label}
        placeholder="h:mm a/p"
        className={`input w-28 py-1 font-mono tabular-nums ${bad ? "border-red-500" : ""} ${highlight ? "bg-brand/5" : ""}`}
      />
      <button
        type="button"
        onClick={() => setDial(true)}
        className="text-fg-muted hover:text-fg px-1"
        title="Pick on a clock"
        aria-label={`Pick ${label || "time"} on a clock`}
      >
        🕘
      </button>
      {dial && (
        <ClockPicker
          hours={d.getHours()}
          minutes={d.getMinutes()}
          snap={snap}
          onCancel={() => setDial(false)}
          onConfirm={(h, m) => {
            setDial(false);
            const next = withTimeOfDay(value, h, m);
            onChange(next);
            setText(formatTime(next));
            setBad(false);
          }}
        />
      )}
    </span>
  );
}
