// Deterministic per-vendor color generation. Each vendor company gets
// the same hue every render (hashed from its id), so the same vendor
// reads the same across sessions and across users. Saturation +
// lightness are fixed so colors stay readable and complementary
// regardless of which hue lands.
//
// Two flavors per vendor:
//   light theme: pastel bg + dark text  (high contrast on white)
//   dark theme:  muted dark bg + light text (high contrast on slate)
//
// Both flavors are returned as CSS custom properties so the consumer
// can swap via Tailwind `dark:` variants without re-rendering.

function hashHue(seed) {
  if (seed === null || seed === undefined) return 0;
  const str = String(seed);
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  // Spread evenly across the wheel, skip a band of yellow-greens that
  // tend to look sickly on both themes (60–100°).
  let hue = Math.abs(h) % 320;
  if (hue >= 60) hue += 40;
  return hue;
}

export function vendorPillStyle(companyId) {
  const hue = hashHue(companyId);
  return {
    "--vendor-bg": `hsl(${hue} 70% 90%)`,
    "--vendor-text": `hsl(${hue} 55% 28%)`,
    "--vendor-bg-dark": `hsl(${hue} 30% 22%)`,
    "--vendor-text-dark": `hsl(${hue} 70% 80%)`,
  };
}

// Tailwind class string that consumes the custom properties from
// vendorPillStyle. Caller spreads the style obj on the element and
// adds these classes.
export const VENDOR_PILL_CLASSES =
  "bg-[var(--vendor-bg)] text-[var(--vendor-text)] " +
  "dark:bg-[var(--vendor-bg-dark)] dark:text-[var(--vendor-text-dark)]";
