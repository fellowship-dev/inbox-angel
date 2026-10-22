// A mock Cloudflare authorization server for the OAuth tests. Not Cloudflare's real one: the endpoint URLs
// and scope names are config in the Worker, so the tests point it here.

export const AUTH = {
  CF_OAUTH_CLIENT_ID: 'ia-test-client',
  CF_OAUTH_AUTHORIZE_URL: 'https://auth.mock.test/authorize',
  CF_OAUTH_TOKEN_URL: 'https://auth.mock.test/token',
  CF_OAUTH_REVOKE_URL: 'https://auth.mock.test/revoke',
  CF_OAUTH_SCOPES: 'zone:read dns:edit',
} as const;

const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Grant { challenge: string; redirectUri: string; clientId: string }

export class MockAuthServer {
  readonly #codes = new Map<string, Grant>();
  readonly #refresh = new Map<string, string>(); // refresh token -> access token it last produced
  readonly revoked: { token: string; hint: string | null }[] = [];
  readonly tokenCalls: { grant: string; body: URLSearchParams }[] = [];
  /** Seconds until an access token expires. */
  expiresIn = 3600;
  /** Reject refresh requests (the grant was revoked at Cloudflare). */
  refreshRejected = false;
  /** Make revocation fail. */
  revokeFails = false;
  /** Called with each newly issued access token (to register it with the fake Cloudflare). */
  onIssue?: (access: string) => void;
  #n = 0;

  /** What the browser does: follow the authorize URL, "consent", get redirected back. Returns the callback URL. */
  authorize(authorizeUrl: string, opts: { approve?: boolean } = {}): string {
    const u = new URL(authorizeUrl);
    const redirect = u.searchParams.get('redirect_uri')!;
    if (u.searchParams.get('client_id') !== AUTH.CF_OAUTH_CLIENT_ID) throw new Error('unknown client');
    if (u.searchParams.get('response_type') !== 'code') throw new Error('response_type must be code');
    if (u.searchParams.get('code_challenge_method') !== 'S256') throw new Error('PKCE S256 required');
    const back = new URL(redirect);
    back.searchParams.set('state', u.searchParams.get('state')!);
    if (opts.approve === false) {
      back.searchParams.set('error', 'access_denied');
      return back.toString();
    }
    const code = `code-${++this.#n}`;
    this.#codes.set(code, { challenge: u.searchParams.get('code_challenge')!, redirectUri: redirect, clientId: u.searchParams.get('client_id')! });
    back.searchParams.set('code', code);
    return back.toString();
  }

  /** The last refresh token issued (for tests that need to poke it). */
  get lastRefresh(): string | undefined { return [...this.#refresh.keys()].at(-1); }

  readonly handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response | null> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== 'auth.mock.test') return null;
    const body = new URLSearchParams(String(init?.body ?? ''));
    const reply = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

    if (url.pathname === '/token') {
      const grant = body.get('grant_type') ?? '';
      this.tokenCalls.push({ grant, body });
      if (grant === 'authorization_code') {
        const g = this.#codes.get(body.get('code') ?? '');
        this.#codes.delete(body.get('code') ?? ''); // single use
        if (!g) return reply(400, { error: 'invalid_grant' });
        if (g.redirectUri !== body.get('redirect_uri')) return reply(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        const verifier = body.get('code_verifier') ?? '';
        const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
        if (challenge !== g.challenge) return reply(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return reply(200, this.#issue());
      }
      if (grant === 'refresh_token') {
        const rt = body.get('refresh_token') ?? '';
        if (this.refreshRejected || !this.#refresh.has(rt)) return reply(400, { error: 'invalid_grant' });
        this.#refresh.delete(rt); // rotation: single use
        return reply(200, this.#issue());
      }
      return reply(400, { error: 'unsupported_grant_type' });
    }

    if (url.pathname === '/revoke') {
      if (this.revokeFails) return reply(503, { error: 'temporarily_unavailable' });
      this.revoked.push({ token: body.get('token') ?? '', hint: body.get('token_type_hint') });
      return reply(200, {});
    }
    return reply(404, { error: 'not_found' });
  };

  #issue() {
    const n = ++this.#n;
    const access = `access-${n}-secret`;
    const refresh = `refresh-${n}-secret`;
    this.#refresh.set(refresh, access);
    this.onIssue?.(access);
    return { access_token: access, refresh_token: refresh, expires_in: this.expiresIn, scope: AUTH.CF_OAUTH_SCOPES, token_type: 'Bearer' };
  }
}
