/** Bound DOM text without joining the complete output on every instruction. */
export const OUTPUT_PAGE_SIZE = 32_768;
export function outputPage(chunks: readonly string[], requested: number | null) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const charAt = (position: number) => {
    for (const chunk of chunks) { if (position < chunk.length) return chunk.charCodeAt(position); position -= chunk.length; }
    return NaN;
  };
  const boundary = (position: number) => {
    if (position <= 0 || position >= total) return Math.min(position, total);
    const before = charAt(position - 1), after = charAt(position);
    return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff ? position + 1 : position;
  };
  let pages = Math.max(1, Math.ceil(total / OUTPUT_PAGE_SIZE));
  // Moving a trailing surrogate pair onto the preceding page can consume the
  // whole nominal last page. Do not follow an empty page instead of the text.
  if (pages > 1 && boundary((pages - 1) * OUTPUT_PAGE_SIZE) === total) pages--;
  const page = requested === null ? pages - 1 : Math.max(0, Math.min(pages - 1, Math.trunc(requested) || 0));
  const start = boundary(page * OUTPUT_PAGE_SIZE), end = boundary((page + 1) * OUTPUT_PAGE_SIZE), parts: string[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    const next = offset + chunk.length;
    if (next > start && offset < end) parts.push(chunk.slice(Math.max(0, start - offset), end - offset));
    offset = next; if (offset >= end) break;
  }
  return { total, pages, page, start, end, text: parts.join('') };
}
