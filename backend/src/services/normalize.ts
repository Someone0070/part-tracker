export function normalizePartNumber(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[-.\s#]/g, "");
}
