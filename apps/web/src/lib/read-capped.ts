/** The biggest request body the API proxy will buffer: the API's own limit (2 MB) plus the multipart envelope. A bigger one is refused before it is read. */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;

/** Reads a request body, giving up (without buffering the rest) as soon as it is bigger than the limit, whatever its Content-Length said. */
export async function readCapped(req: Request, limit = MAX_BODY_BYTES): Promise<ArrayBuffer | 'too_large'> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return 'too_large';
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}
