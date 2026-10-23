// Data export for one workspace (GET /api/workspaces/:id/export): a subject-access / portability copy, as JSON.
//
// Streamed section by section, a page of rows at a time, so a big workspace never has to fit in memory.
// What is left out is decided in packages/db/src/queries/export.ts (secrets, hashes, raw report payloads).

import { exportQueries } from '@inbox-angel/db';

const PAGE = 1000;

const NOTES = [
  'Everything this workspace holds in Inbox Angel, as of exported_at.',
  'Left out: password hashes, session and invite tokens, API-key hashes, stored Cloudflare tokens, and the raw report XML/JSON (the parsed rows below are what it contained).',
  'Timestamps are unix seconds (UTC).',
] as const;

export function streamWorkspaceExport(db: D1Database, workspaceId: string, requestedBy: string): Response {
  const q = exportQueries(db, workspaceId);
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const out = (s: string) => controller.enqueue(enc.encode(s));
      try {
        out(`{"exported_at":${Math.floor(Date.now() / 1000)},"requested_by":${JSON.stringify(requestedBy)},"workspace_id":${JSON.stringify(workspaceId)},"notes":${JSON.stringify(NOTES)}`);
        out(`,"workspace":${JSON.stringify((await q.workspace())[0] ?? null)}`);
        for (const [name, read] of Object.entries(q.small)) out(`,${JSON.stringify(name)}:${JSON.stringify(await read())}`);
        for (const [name, page] of Object.entries(q.paged)) {
          out(`,${JSON.stringify(name)}:[`);
          let after = 0;
          let first = true;
          for (;;) {
            const rows = await page(after, PAGE);
            if (rows.length) {
              out((first ? '' : ',') + rows.map(r => JSON.stringify(r)).join(','));
              first = false;
              after = Number(rows[rows.length - 1].id);
            }
            if (rows.length < PAGE) break;
          }
          out(']');
        }
        out('}');
        controller.close();
      } catch (e) {
        console.error(`[export] workspace ${workspaceId} failed:`, e instanceof Error ? e.message : e);
        controller.error(e);
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="inbox-angel-${workspaceId}-export.json"`,
      'cache-control': 'no-store',
    },
  });
}
