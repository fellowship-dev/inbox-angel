// Data export for one workspace (GET /api/workspaces/:id/export): a subject-access / portability copy, as JSON.
//
// Streamed section by section, a page of rows at a time, so a big workspace never has to fit in memory.
// What is left out is decided in packages/db/src/queries/export.ts (secrets, hashes, raw report payloads).

import { exportQueries } from '@inbox-angel/db';

const PAGE = 5000;
/** Rows in the big tables beyond which one invocation cannot read the workspace (D1 query budget and time). */
export const EXPORT_MAX_ROWS = 250_000;

const NOTES = [
  'Everything this workspace holds in Inbox Angel, as of exported_at.',
  'Left out: password hashes, session and invite tokens, API-key hashes, stored Cloudflare tokens, secret settings, and the raw report XML/JSON (the parsed rows below are what it contained).',
  'Timestamps are unix seconds (UTC).',
] as const;

/** The JSON document, in chunks, one page of rows at a time. */
async function* chunks(db: D1Database, workspaceId: string, requestedBy: string): AsyncGenerator<string> {
  const q = exportQueries(db, workspaceId);
  yield `{"exported_at":${Math.floor(Date.now() / 1000)},"requested_by":${JSON.stringify(requestedBy)},"workspace_id":${JSON.stringify(workspaceId)},"notes":${JSON.stringify(NOTES)}`;
  yield `,"workspace":${JSON.stringify((await q.workspace())[0] ?? null)}`;
  for (const [name, read] of Object.entries(q.small)) yield `,${JSON.stringify(name)}:${JSON.stringify(await read())}`;
  for (const [name, page] of Object.entries(q.paged)) {
    yield `,${JSON.stringify(name)}:[`;
    let after = 0;
    let first = true;
    for (;;) {
      const rows = await page(after, PAGE);
      if (rows.length) {
        yield (first ? '' : ',') + rows.map(r => JSON.stringify(r)).join(',');
        first = false;
        after = Number(rows[rows.length - 1].id);
      }
      if (rows.length < PAGE) break;
    }
    yield ']';
  }
  yield '}';
}

/**
 * Pull-based: a page is read only when the client has consumed the previous chunk, so memory holds one page.
 * If a read fails part-way the stream is errored (the connection aborts) rather than closed, so a client never
 * receives truncated JSON that looks complete.
 */
export function exportStream(db: D1Database, workspaceId: string, requestedBy: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const gen = chunks(db, workspaceId, requestedBy);
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const next = await gen.next();
          if (next.done) controller.close();
          else controller.enqueue(enc.encode(next.value));
        } catch (e) {
          console.error(`[export] workspace ${workspaceId} failed part-way:`, e instanceof Error ? e.message : e);
          controller.error(e);
        }
      },
      async cancel() { await gen.return(undefined); },
    },
    { highWaterMark: 0 },
  );
}

export async function streamWorkspaceExport(db: D1Database, workspaceId: string, requestedBy: string, maxRows = EXPORT_MAX_ROWS): Promise<Response> {
  const rows = await exportQueries(db, workspaceId).bigRowCount();
  if (rows > maxRows) {
    return Response.json({
      error: `this workspace is too large to export in one request (${rows.toLocaleString('en')} rows, the limit is ${maxRows.toLocaleString('en')}). Ask the operator for a bulk export, or delete old reports first.`,
      code: 'export_too_large',
    }, { status: 413 });
  }
  return new Response(exportStream(db, workspaceId, requestedBy), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="inbox-angel-${workspaceId}-export.json"`,
      'cache-control': 'no-store',
    },
  });
}
