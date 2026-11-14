// Memory of reading one inbound message's attachment (src/email/mime-extract.ts) for a message of a given raw size.
//   npx esbuild scripts/measure-mime.ts --bundle --platform=node --format=esm --outfile=/tmp/measure-mime.mjs
//   node --expose-gc --max-old-space-size=<MB> /tmp/measure-mime.mjs <attachment MB>
import { extractAttachmentBytes } from '../src/email/mime-extract';

const mb = Number(process.argv[2] ?? 5);
const payload = new Uint8Array(mb * 1048576);
for (let i = 0; i < payload.length; i += 4096) payload[i] = (i / 4096) & 255; // some entropy; the size is what matters
const b64 = Buffer.from(payload).toString('base64').replace(/(.{76})/g, '$1\r\n');
const mime = ['From: a@b.example', 'To: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="B"', '', '--B', 'Content-Type: application/gzip; name="r.xml.gz"', 'Content-Transfer-Encoding: base64', '', b64, '--B--', ''].join('\r\n');
const raw = new TextEncoder().encode(mime);
(globalThis as any).gc?.();
const base = process.memoryUsage();
const t0 = performance.now();
const out = await extractAttachmentBytes(new Response(raw).body!);
const ms = performance.now() - t0;
const usage = process.resourceUsage();
console.log(JSON.stringify({ attachmentMB: mb, rawMB: +(raw.length / 1048576).toFixed(1), extractedMB: +(out.length / 1048576).toFixed(1), ms: Math.round(ms), maxRssMB: +(usage.maxRSS / 1024).toFixed(0), baseHeapMB: +(base.heapUsed / 1048576).toFixed(0) }));
