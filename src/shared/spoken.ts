/**
 * Turns nursing shorthand into something a speech synthesiser reads correctly.
 *
 * Lives in shared rather than beside the hook because it is pure string work
 * with no DOM dependency, which keeps it testable without a browser
 * environment -- and the voice spelling out "m E q slash L" would defeat the
 * point of reading aloud at all.
 */

/** Expansions so the voice reads nursing shorthand as words, not letters. */
const SPOKEN: [RegExp, string][] = [
  [/\bmEq\/L\b/g, 'milliequivalents per liter'],
  [/\bmg\/dL\b/g, 'milligrams per deciliter'],
  [/\bmmol\/L\b/g, 'millimoles per liter'],
  [/\bng\/mL\b/g, 'nanograms per milliliter'],
  [/\bmcg\/kg\b/g, 'micrograms per kilogram'],
  [/\bmg\/kg\b/g, 'milligrams per kilogram'],
  [/\bmL\b/g, 'milliliters'],
  [/\bmmHg\b/g, 'millimeters of mercury'],
  [/\bbpm\b/gi, 'beats per minute'],
  [/\bK\+/g, 'potassium'],
  [/\bNa\+/g, 'sodium'],
  [/\bCa\+{0,2}\b/g, 'calcium'],
  [/\bMg\+{0,2}\b/g, 'magnesium'],
  [/\bHCO3-?\b/g, 'bicarbonate'],
  [/\bPaCO2\b/g, 'P A C O 2'],
  [/\bPaO2\b/g, 'P A O 2'],
  [/\bABG\b/g, 'arterial blood gas'],
  [/\bIV\b/g, 'I V'],
  [/\bPO\b/g, 'by mouth'],
  [/\bNPO\b/g, 'nothing by mouth'],
  [/\bq(\d+)h\b/g, 'every $1 hours'],
  // A cloze blank should be heard as a pause, not as punctuation.
  [/\{\{[^}]*\}\}|______/g, ' blank '],
  // Ranges read as "3.5 to 5.0" rather than "3.5 minus 5.0".
  [/(\d)\s*-\s*(\d)/g, '$1 to $2'],
];

export function toSpokenText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SPOKEN) out = out.replace(pattern, replacement);
  // Collapse whitespace so the voice does not pause oddly.
  return out.replace(/\s+/g, ' ').trim();
}

