import type { BuildingModelV1 } from './building-model';

/** Stable checksum for revision storage (not cryptographic security). */
export async function checksumModel(model: BuildingModelV1): Promise<string> {
  const payload = JSON.stringify(model);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const data = new TextEncoder().encode(payload);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // Fallback for older runtimes
  let h = 0;
  for (let i = 0; i < payload.length; i++) {
    h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
  }
  return `fnv-${(h >>> 0).toString(16)}`;
}
