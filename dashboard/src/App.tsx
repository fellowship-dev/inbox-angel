import { useState, useEffect } from 'preact/hooks';
import { useIsMobile } from './hooks';
import { Overview } from './pages/Overview';
import { DomainDetail } from './pages/Domain';
import { AddDomain } from './pages/AddDomain';
import { ReportDetail } from './pages/ReportDetail';
import { DomainSettings } from './pages/DomainSettings';
import { Explore } from './pages/Explore';
import { Anomalies } from './pages/Anomalies';
import { ReportBrowser } from './pages/ReportBrowser';
import { EmailCheck } from './pages/EmailCheck';
import { Team } from './pages/Team';
import { AuditLog } from './pages/AuditLog';
import { AcceptInvite } from './pages/AcceptInvite';
import { ResetPassword } from './pages/ResetPassword';
import { Onboarding } from './pages/Onboarding';
import { SpfFlattenWizard } from './pages/SpfFlattenWizard';
import { MtaStsWizard } from './pages/MtaStsWizard';
import { BulkImport } from './pages/BulkImport';
import { CTDiscover } from './pages/CTDiscover';
import { DmarcWizard } from './pages/DmarcWizard';
import { AuthGate } from './AuthGate';
import { getVersion, logout, type VersionInfo } from './api';

const DISMISS_KEY = 'ia_update_dismissed';

function UpdateBanner({ info, onDismiss }: { info: VersionInfo; onDismiss: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '0.75rem', flexWrap: 'wrap',
      background: '#fefce8', border: '1px solid #fde68a',
      borderRadius: '8px', padding: '0.6rem 1rem', marginBottom: '1rem',
      fontSize: '0.875rem', color: '#92400e',
    }}>
      <span>
        New version available: <strong>v{info.latest}</strong>
        {' '}— you're on <strong>v{info.current}</strong>
      </span>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexShrink: 0 }}>
        <a href={info.release_url} target="_blank" rel="noreferrer" style={{
          color: '#92400e', fontWeight: 600, textDecoration: 'underline',
        }}>
          View release
        </a>
        <button onClick={onDismiss} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: '#b45309', fontSize: '1rem', lineHeight: 1, padding: '0 2px',
        }}>✕</button>
      </div>
    </div>
  );
}

function getRoute(): string {
  return window.location.hash.replace(/^#/, '') || '/';
}

function navActive(route: string, section: 'domains' | 'check' | 'team' | 'audit'): boolean {
  if (section === 'check') return route === '/check';
  if (section === 'team')  return route === '/team';
  if (section === 'audit') return route === '/audit';
  return route === '/' || route === '/add' || route.startsWith('/domains/');
}

function CustomDomainBanner({ hostname }: { hostname: string }) {
  const url = `https://${hostname}`;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      gap: '0.75rem', flexWrap: 'wrap',
      background: '#eff6ff', border: '1px solid #bfdbfe',
      borderRadius: '8px', padding: '0.6rem 1rem', marginBottom: '1rem',
      fontSize: '0.875rem', color: '#1e40af',
    }}>
      <span>Your dashboard is available at <strong>{hostname}</strong></span>
      <a href={url} style={{ color: '#1e40af', fontWeight: 600, textDecoration: 'underline', flexShrink: 0 }}>
        Switch →
      </a>
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState(getRoute);
  const [hasKey, setHasKey] = useState(() => !!localStorage.getItem('ia_api_key'));
  // No stored token: an OAuth sign-in leaves a session cookie instead. Probe once.
  const [probing, setProbing] = useState(() => !localStorage.getItem('ia_api_key'));
  const [update, setUpdate] = useState<VersionInfo | null>(null);
  const [customDomain, setCustomDomain] = useState<string | null>(null);
  const handleUnauth = () => { localStorage.removeItem('ia_api_key'); setHasKey(false); };

  // Unauthenticated routes — must be checked before auth gate
  const inviteMatch = route.match(/^\/invite\/(.+)$/);
  if (inviteMatch) {
    return <AcceptInvite token={inviteMatch[1]} onAccepted={() => setHasKey(true)} />;
  }
  const resetMatch = route.match(/^\/reset\/(.+)$/);
  if (resetMatch) {
    return <ResetPassword token={resetMatch[1]} onReset={() => { setHasKey(true); window.location.hash = '/'; }} />;
  }

  useEffect(() => {
    const onHash = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (!probing) return;
    fetch('/api/auth/get-session')
      .then(r => r.ok ? r.json() : null)
      .then(sess => { if (sess) setHasKey(true); })
      .catch(() => {})
      .finally(() => setProbing(false));
  }, []);

  useEffect(() => {
    if (sessionStorage.getItem(DISMISS_KEY)) return;
    getVersion().then(v => { if (v.update_available) setUpdate(v); }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!hasKey) return;
    fetch('/api/auth/status')
      .then(r => r.json() as Promise<{ custom_domain?: string | null; has_domain?: boolean }>)
      .then(s => {
        if (s.custom_domain && window.location.hostname !== s.custom_domain) {
          setCustomDomain(s.custom_domain);
        }
        // No domain configured — redirect to setup wizard
        if (s.has_domain === false && !window.location.hash.includes('/setup')) {
          window.location.hash = '#/setup';
        }
      })
      .catch(() => {});
  }, [hasKey]);

  const mobile = useIsMobile();

  if (!hasKey && probing) return null;
  if (!hasKey) return <AuthGate onSave={() => setHasKey(true)} />;

  // SPF Flatten wizard — full-screen, outside nav shell
  const spfFlatMatch = route.match(/^\/domains\/(\d+)\/spf-flatten$/);
  if (spfFlatMatch) {
    return <SpfFlattenWizard domainId={parseInt(spfFlatMatch[1], 10)} onUnauthorized={handleUnauth} />;
  }

  // MTA-STS wizard — full-screen, outside nav shell
  const mtaStsMatch = route.match(/^\/domains\/(\d+)\/mta-sts$/);
  if (mtaStsMatch) {
    return <MtaStsWizard domainId={parseInt(mtaStsMatch[1], 10)} onUnauthorized={handleUnauth} />;
  }

  // DMARC graduation wizard — full-screen, outside nav shell
  const dmarcWizardMatch = route.match(/^\/domains\/(\d+)\/dmarc-wizard$/);
  if (dmarcWizardMatch) {
    return <DmarcWizard domainId={parseInt(dmarcWizardMatch[1], 10)} onUnauthorized={handleUnauth} />;
  }

  // Setup wizard — /domains/:id/setup/:step (1-indexed) or /setup (auto-resolve domain)
  const setupMatch = route.match(/^\/domains\/(\d+)\/setup(?:\/(\d+))?$/);
  if (setupMatch) {
    const domainIdFromUrl = parseInt(setupMatch[1], 10);
    const stepFromUrl = setupMatch[2] !== undefined ? parseInt(setupMatch[2], 10) : undefined;
    return <Onboarding domainId={domainIdFromUrl} initialStep={stepFromUrl} />;
  }
  // Legacy /onboarding or /setup — resolve domain and redirect
  if (route === '/setup' || route.startsWith('/onboarding')) {
    return <Onboarding />;
  }

  return (
    <div style={{ ...styles.shell, padding: mobile ? '0 1rem' : '0 1.5rem' }}>
      <header style={styles.header}>
        <a href="#/" style={styles.logo}>InboxAngel</a>
        <nav style={styles.nav}>
          <a href="#/" style={{ ...styles.navLink, ...(navActive(route, 'domains') ? styles.navLinkActive : {}) }}>
            Domains
          </a>
          <a href="#/check" style={{ ...styles.navLink, ...(navActive(route, 'check') ? styles.navLinkActive : {}) }}>
            {mobile ? 'Check' : 'Email check'}
          </a>
          <a href="#/team" style={{ ...styles.navLink, ...(navActive(route, 'team') ? styles.navLinkActive : {}) }}>
            Team
          </a>
          <a href="#/audit" style={{ ...styles.navLink, ...(navActive(route, 'audit') ? styles.navLinkActive : {}) }}>
            {mobile ? 'Log' : 'Audit log'}
          </a>
          <button
            onClick={async () => { await logout(); setHasKey(false); }}
            style={styles.logoutBtn}
          >
            {mobile ? '↩' : 'Sign out'}
          </button>
        </nav>
      </header>
      <main style={styles.main}>
        {customDomain && <CustomDomainBanner hostname={customDomain} />}
        {update && (
          <UpdateBanner info={update} onDismiss={() => {
            sessionStorage.setItem(DISMISS_KEY, '1');
            setUpdate(null);
          }} />
        )}
        {route === '/' && <Overview onUnauthorized={handleUnauth} />}
        {route === '/add' && <AddDomain onUnauthorized={handleUnauth} />}
        {route === '/bulk-import' && <BulkImport onUnauthorized={handleUnauth} />}
        {route === '/ct-discover' && <CTDiscover onUnauthorized={handleUnauth} />}
        {route === '/check' && <EmailCheck />}
        {route === '/team'  && <Team onUnauthorized={handleUnauth} />}
        {route === '/audit' && <AuditLog onUnauthorized={handleUnauth} />}
        {/^\/domains\/(\d+)$/.test(route) && !/\/settings$/.test(route) && (
          <DomainDetail id={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/settings$/.test(route) && (
          <DomainSettings id={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/explore$/.test(route) && (
          <Explore domainId={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/anomalies$/.test(route) && (
          <Anomalies domainId={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {/^\/domains\/(\d+)\/reports$/.test(route) && (
          <ReportBrowser domainId={parseInt(route.split('/')[2], 10)} onUnauthorized={handleUnauth} />
        )}
        {(() => {
          const m = route.match(/^\/domains\/(\d+)\/reports\/(\d{4}-\d{2}-\d{2})$/);
          return m ? <ReportDetail domainId={parseInt(m[1], 10)} date={m[2]} onUnauthorized={handleUnauth} /> : null;
        })()}
        {route !== '/' && route !== '/add' && route !== '/bulk-import' && route !== '/ct-discover' && route !== '/check' && route !== '/team' && route !== '/audit' &&
         !/^\/domains\/\d+$/.test(route) &&
         !/^\/domains\/\d+\/settings$/.test(route) &&
         !/^\/domains\/\d+\/explore$/.test(route) &&
         !/^\/domains\/\d+\/anomalies$/.test(route) &&
         !/^\/domains\/\d+\/reports$/.test(route) &&
         !/^\/domains\/\d+\/reports\/\d{4}-\d{2}-\d{2}$/.test(route) &&
         !/^\/domains\/\d+\/spf-flatten$/.test(route) &&
         !/^\/domains\/\d+\/mta-sts$/.test(route) &&
         !/^\/domains\/\d+\/dmarc-wizard$/.test(route) && (
          <p style={{ color: '#9ca3af' }}>Page not found. <a href="#/">Back to overview</a></p>
        )}
      </main>
    </div>
  );
}

const styles = {
  shell: {
    fontFamily: 'system-ui, -apple-system, sans-serif',
    maxWidth: '1040px',
    margin: '0 auto',
    padding: '0 1.5rem',
    color: '#111827',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '1.25rem 0',
    borderBottom: '1px solid #e5e7eb',
    marginBottom: '1.5rem',
  } as const,
  logo: {
    fontWeight: 700,
    fontSize: '1.1rem',
    textDecoration: 'none',
    color: '#111827',
  } as const,
  nav: {
    display: 'flex',
    gap: '1rem',
  } as const,
  navLink: {
    fontSize: '0.875rem',
    textDecoration: 'none',
    color: '#6b7280',
  } as const,
  navLinkActive: {
    color: '#111827',
    fontWeight: 600,
  } as const,
  logoutBtn: {
    background: 'none',
    border: 'none',
    padding: 0,
    fontSize: '0.875rem',
    color: '#9ca3af',
    cursor: 'pointer',
    fontFamily: 'inherit',
  } as const,
  main: {
    paddingBottom: '3rem',
  } as const,
};
