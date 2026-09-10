import type { UploadTicket } from '@banana-chat/shared';
export interface CompletedPart { part_number: number; etag: string }
/** FR-MEDIA-001: platform adapters supply byte slices; core owns multipart ordering. */
export async function uploadTicket(ticket: UploadTicket, size: number,
  put: (url: string, headers: Record<string, string>, start: number, end: number) => Promise<string | null>): Promise<CompletedPart[] | undefined> {
  if (!ticket.multipart) {
    if (!ticket.put_url) throw new Error('Upload URL missing');
    await put(ticket.put_url, ticket.headers, 0, size);
    return undefined;
  }
  const { part_size, part_urls } = ticket.multipart;
  if (part_size <= 0 || part_urls.length !== Math.ceil(size / part_size)) throw new Error('Invalid multipart upload ticket');
  const parts: CompletedPart[] = [];
  for (const [index, url] of part_urls.entries()) {
    const etag = await put(url, ticket.headers, index * part_size, Math.min(size, (index + 1) * part_size));
    if (!etag) throw new Error('Upload response missing ETag; check storage CORS ExposeHeaders');
    parts.push({ part_number: index + 1, etag });
  }
  return parts;
}
