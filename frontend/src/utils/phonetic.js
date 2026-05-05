// NATO phonetic readback parser. Sourced from the alphabet-soup project
// (github.com/jhearne/alphabet-soup). Used to show a hover popover that
// breaks ticket refs like "WEB-0079" into "Whiskey Echo Bravo - 0 0 7 9"
// for verbal readback to vendors / contacts on a phone call.

export const NATO = {
  A: "Alpha", B: "Bravo", C: "Charlie", D: "Delta", E: "Echo",
  F: "Foxtrot", G: "Golf", H: "Hotel", I: "India", J: "Juliet",
  K: "Kilo", L: "Lima", M: "Mike", N: "November", O: "Oscar",
  P: "Papa", Q: "Quebec", R: "Romeo", S: "Sierra", T: "Tango",
  U: "Uniform", V: "Victor", W: "Whiskey", X: "X-ray", Y: "Yankee",
  Z: "Zulu",
};

// Parse a ref string into ordered tokens. Letters resolve to NATO words;
// digits and the dash are kept as-is (digits don't get a spoken callout —
// the digit character is what's read aloud).
export function parseRef(input) {
  if (!input) return [];
  return String(input).split("").map((ch) => {
    const upper = ch.toUpperCase();
    if (NATO[upper]) return { char: ch, word: NATO[upper], type: "nato" };
    if (/[0-9]/.test(ch)) return { char: ch, word: ch, type: "number" };
    if (ch === "-") return { char: ch, word: ch, type: "dash" };
    return { char: ch, word: ch, type: "unknown" };
  });
}

// Flat readback string. Letters use NATO words, digits and dashes stay
// as their raw character: "WEB-0079" -> "Whiskey Echo Bravo - 0 0 7 9".
export function readbackString(input) {
  return parseRef(input).map((t) => t.word).join(" ");
}
