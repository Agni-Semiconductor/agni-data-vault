// Read a filename back out of a Content-Disposition header.
//
// Lives here rather than in the page because the page must export a component alone, and
// because this is the only test surface for the trick it enables: there is no
// GET /api/files/:id route, so a figure learns a source's filename from the SAME response
// that carries its bytes. detectKind reads that name, and the wrong name picks the wrong axes.
/** Pull a filename out of a Content-Disposition header, preferring the RFC 5987 encoded form. */
export function filenameFrom(header: string | null): string | undefined {
  if (!header) return undefined
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (encoded) { try { return decodeURIComponent(encoded[1].trim()) } catch { return encoded[1].trim() } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : undefined
}
