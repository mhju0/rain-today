export interface ResponseByteLimits {
  maxBytes: number;
  /** MIME type prefix, without parameters (for example application/json). */
  contentType?: string;
}

/** Buffer a response only after enforcing its declared and streamed byte limits. */
export async function readResponseBytes(
  response: Response,
  { maxBytes, contentType }: ResponseByteLimits,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("invalid response byte limit");

  if (contentType) {
    const actual = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (actual !== contentType.toLowerCase()) throw new Error("unexpected response content type");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
      throw new Error("response body too large");
    }
  }

  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response body too large");
        throw new Error("response body too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
