/**
 * Colour helpers for category and product buttons: pick a text colour that meets WCAG AA
 * against a user-chosen background (buttonColour / category colour, '#rrggbb').
 */

const HEX = /^#([0-9a-f]{6})$/i;

/**
 * Pure black: with white as the other choice, whichever contrasts more always reaches at least
 * sqrt(21) ≈ 4.58:1 (AA for normal text). A near-black left mid-tones such as #7b7b7b at 4.26:1.
 */
export const DARK_TEXT = '#000000';
export const LIGHT_TEXT = '#ffffff';
/** Used when a stored colour is not '#rrggbb'. */
export const FALLBACK_COLOUR = '#166534';

export function isHexColour(value: string): boolean {
  return HEX.test(value);
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of '#rrggbb' (0..1). */
export function relativeLuminance(hex: string): number {
  const match = HEX.exec(hex);
  const body = match?.[1] ?? FALLBACK_COLOUR.slice(1);
  const r = Number.parseInt(body.slice(0, 2), 16);
  const g = Number.parseInt(body.slice(2, 4), 16);
  const b = Number.parseInt(body.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two '#rrggbb' colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** White or black, whichever contrasts more with `background` (always >= 4.5:1, WCAG AA). */
export function readableTextColour(background: string): string {
  const bg = isHexColour(background) ? background : FALLBACK_COLOUR;
  return contrastRatio(bg, LIGHT_TEXT) >= contrastRatio(bg, DARK_TEXT) ? LIGHT_TEXT : DARK_TEXT;
}

/** The colour itself when valid, else FALLBACK_COLOUR. */
export function safeColour(value: string): string {
  return isHexColour(value) ? value : FALLBACK_COLOUR;
}
