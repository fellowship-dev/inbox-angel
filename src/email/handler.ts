import type { BoundEnv as Env } from '../index';
import { handleFreeCheck } from './free-check';
import { handleDmarcReport } from './dmarc-report';
import { handleTlsRptReport } from './tls-rpt';
import { track } from '../telemetry';

// Routes inbound email by recipient address local part:
//   rua@reports.yourdomain.com      → DMARC RUA aggregate report (routed by XML content)
//   tls-rpt@reports.yourdomain.com  → TLS-RPT JSON report (RFC 8460)
//   {token}@reports.yourdomain.com  → free SPF/DKIM/DMARC check (8-char random token)
export async function handleEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const to = message.to.toLowerCase();
  const localPart = to.split('@')[0];

  if (localPart === 'rua') {
    const { failure_count } = await handleDmarcReport(message, env);
    track(env, { event: 'report.received', failure_count }); // fire-and-forget
  } else if (localPart === 'tls-rpt') {
    const { failure_count } = await handleTlsRptReport(message, env);
    track(env, { event: 'tls-rpt.received', failure_count }); // fire-and-forget
  } else {
    const { result } = await handleFreeCheck(message, env, localPart);
    track(env, { event: 'check.received', result }); // fire-and-forget
  }
}
