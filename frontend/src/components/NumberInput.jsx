import { useState } from "react";

// <input type="number"> that lets the field sit empty while you type.
//
// A plain controlled input with onChange={Number(e.target.value)} turns
// a cleared field into 0 on the spot, so typing "15" gives "015". This
// keeps the typed text while focused and only reports a value when the
// text is a number. On blur a blank field takes `emptyValue` when one is
// given, otherwise it goes back to what it held when focused.
//
//   value       number (or "" / null for none)
//   onChange    (number) => void
//   emptyValue  number to commit when left blank (optional)
//   format      (value) => string shown while not focused (optional)
export default function NumberInput({ value, onChange, emptyValue, format, onFocus, onBlur, ...rest }) {
  const [draft, setDraft] = useState(null); // text while focused, else null
  const [atFocus, setAtFocus] = useState(null); // value when focused
  const shown = value === null || value === undefined || value === ""
    ? ""
    : format ? format(value) : String(value);

  return (
    <input
      type="number"
      {...rest}
      value={draft ?? shown}
      onFocus={(e) => { setDraft(shown); setAtFocus(value); onFocus?.(e); }}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        if (text.trim() !== "" && Number.isFinite(Number(text))) onChange(Number(text));
      }}
      onBlur={(e) => {
        if ((draft ?? "").trim() === "") {
          const back = emptyValue !== undefined ? emptyValue : atFocus;
          if (back !== null && back !== undefined && back !== "" && back !== value) onChange(back);
        }
        setDraft(null);
        onBlur?.(e);
      }}
    />
  );
}
