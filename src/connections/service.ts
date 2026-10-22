// Cloudflare connections of one account: store, open, refresh, restrict, revoke.
//
// One ConnectionService belongs to one TenantContext (one request, or one cron account). It keeps no
// module-level state: opened tokens and clients are cached on the instance, which dies with the request.
//
// The CfClient it hands out for a connection
//   * reads the access token lazily and refreshes it once when it has expired (OAuth),
//   * retries a 401 once after a forced refresh; a second 401 marks the connection broken,
//   * carries the owner's zone allow-list and refuses every call outside it,
//   * throws CfConnectionError (not a generic failure) when the connection is broken or revoked.

import type { AccountScope, CfConnectionInfo, CfConnectionZone } from '@inbox-angel/db';
import {
  CfAuthError,
  CfClient,
  CfConnectionError,
  CfZoneNotAllowedError,
  type CfPolicy,
} from '../tenancy/cf-client';
import { TokenCrypto, TokenMaterial, envelopeAad, type CryptoEnv } from './crypto';
import {
  OAuthError,
  oauthConfig,
  refreshTokens,
  revokeToken,
  type OAuthEnv,
  type OAuthTokens,
} from './oauth';

export type ConnectionEnv = CryptoEnv & OAuthEnv;

/** What the connection layer needs from its tenant. */
export interface ConnectionHost {
  accountId: string;
  scope: AccountScope;
  env: ConnectionEnv;
  fetch?: typeof fetch;
  /** Called once when a connection turns broken (alert path). */
  onBroken?: (info: { id: string; label: string; detail: string }) => void | Promise<void>;
  now?: () => number;
}

/** A request the caller got wrong (bad token, unknown zone…): maps to a 4xx. */
export class ConnectionInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) {
    super(message);
    this.name = 'ConnectionInputError';
  }
}

export interface PublicConnection {
  id: string;
  label: string;
  auth_type: 'oauth' | 'token';
  status: 'active' | 'broken' | 'revoked';
  status_detail: string | null;
  cf_account_id: string | null;
  cf_account_name: string | null;
  scopes: string[];
  created_by: string | null;
  created_at: number;
  last_used_at: number | null;
  zones: { id: string; name: string }[];
  /** The self-host CLOUDFLARE_API_TOKEN, shown as a connection: cannot be edited or deleted. */
  implicit?: true;
}

export const IMPLICIT_CONNECTION_ID = 'env';

/** A connection row as the API shows it: no envelope, ever. */
export function toPublic(c: CfConnectionInfo, zones: CfConnectionZone[]): PublicConnection {
  return {
    id: c.id,
    label: c.label,
    auth_type: c.auth_type,
    status: c.status,
    status_detail: c.status_detail,
    cf_account_id: c.cf_account_id,
    cf_account_name: c.cf_account_name,
    scopes: (c.scopes ?? '').split(/\s+/).filter(Boolean),
    created_by: c.created_by,
    created_at: c.created_at,
    last_used_at: c.last_used_at,
    zones: zones.map(z => ({ id: z.zone_id, name: z.zone_name })),
  };
}

interface Opened { envelope: string; material: TokenMaterial }

const LAST_USED_THROTTLE_SECONDS = 300;
const newId = () => 'cfc_' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');

export class ConnectionService {
  readonly #host: ConnectionHost;
  readonly #opened = new Map<string, Promise<Opened>>();
  readonly #refreshing = new Map<string, Promise<Opened>>();
  readonly #clients = new Map<string, Promise<CfClient>>();
  #crypt?: TokenCrypto;

  constructor(host: ConnectionHost) {
    this.#host = host;
  }

  get #now(): number { return this.#host.now ? this.#host.now() : Math.floor(Date.now() / 1000); }
  get #fetch(): typeof fetch { return this.#host.fetch ?? ((i, init) => globalThis.fetch(i, init)); }

  /** Throws TokenKeyError when TOKEN_ENCRYPTION_KEY is missing: nothing can be stored or opened without it. */
  get crypt(): TokenCrypto {
    return (this.#crypt ??= TokenCrypto.fromEnv(this.#host.env));
  }

  /** Forget cached tokens and clients (the allow-list or a token changed). */
  invalidate(): void {
    this.#opened.clear();
    this.#refreshing.clear();
    this.#clients.clear();
  }

  // ── Reading ────────────────────────────────────────────────

  async list(): Promise<PublicConnection[]> {
    const q = this.#host.scope.connections;
    const rows = await q.list();
    return Promise.all(rows.map(async r => toPublic(r, await q.zones(r.id))));
  }

  async get(id: string): Promise<PublicConnection | null> {
    const q = this.#host.scope.connections;
    const row = await q.get(id);
    return row ? toPublic(row, await q.zones(id)) : null;
  }

  /** Is there at least one connection a request could use? */
  async hasActive(): Promise<boolean> {
    return (await this.#host.scope.connections.list()).some(c => c.status === 'active');
  }

  // ── Creating ───────────────────────────────────────────────

  /** Validate a pasted API token with Cloudflare, then store it encrypted. Zones start unallowed. */
  async addToken(p: { token: string; label?: string; createdBy?: string | null }): Promise<PublicConnection> {
    const crypt = this.crypt;
    const cf = new CfClient(p.token, { fetch: this.#host.fetch });
    let verified: { status: string; expires_on?: string };
    try {
      verified = await cf.verifyToken();
    } catch (e) {
      if (e instanceof CfAuthError) throw new ConnectionInputError('Cloudflare did not accept this API token');
      throw e;
    }
    if (verified.status !== 'active') throw new ConnectionInputError(`this API token is not active (${verified.status})`);
    const expires = verified.expires_on ? Math.floor(Date.parse(verified.expires_on) / 1000) : NaN;
    const account = await this.#soleAccount(cf);

    const id = newId();
    const envelope = await crypt.seal({ access: p.token, expiresAt: Number.isFinite(expires) ? expires : undefined }, envelopeAad(this.#host.accountId, id));
    await this.#host.scope.connections.insert({
      id,
      label: cleanLabel(p.label) ?? account?.name ?? 'Cloudflare API token',
      cf_account_id: account?.id,
      cf_account_name: account?.name,
      auth_type: 'token',
      token_envelope: envelope,
      created_by: p.createdBy,
    });
    return (await this.get(id))!;
  }

  /** Store the tokens an OAuth flow produced. With `replace`, reconnect that connection instead. */
  async addOAuth(p: { tokens: OAuthTokens; label?: string; createdBy?: string | null; replace?: string }): Promise<PublicConnection> {
    const crypt = this.crypt;
    const q = this.#host.scope.connections;
    const cf = new CfClient(p.tokens.material.access(), { fetch: this.#host.fetch });
    const account = await this.#soleAccount(cf);
    const scopes = p.tokens.scopes.join(' ') || null;

    if (p.replace) {
      const existing = await q.getSecret(p.replace);
      if (!existing || existing.auth_type !== 'oauth') throw new CfConnectionError('missing', p.replace);
      try {
        await this.#assertSameAccount(p.replace, existing.cf_account_id, cf);
      } catch (e) {
        // A grant for the wrong Cloudflare account is of no use to anyone: give it back.
        const cfg = safeOauthConfig(this.#host.env);
        if (cfg) {
          const m = p.tokens.material;
          if (m.refresh()) await revokeToken(cfg, m.refresh()!, 'refresh_token', this.#fetch);
          await revokeToken(cfg, m.access(), 'access_token', this.#fetch);
        }
        throw e;
      }
      await q.reactivate(p.replace, await crypt.seal(p.tokens.material, envelopeAad(this.#host.accountId, p.replace)), scopes);
      this.invalidate();
      return (await this.get(p.replace))!;
    }

    const id = newId();
    await q.insert({
      id,
      label: cleanLabel(p.label) ?? account?.name ?? 'Cloudflare',
      cf_account_id: account?.id,
      cf_account_name: account?.name,
      auth_type: 'oauth',
      token_envelope: await crypt.seal(p.tokens.material, envelopeAad(this.#host.accountId, id)),
      scopes,
      created_by: p.createdBy,
    });
    return (await this.get(id))!;
  }

  /** Replace the token of a pasted-token connection (after it broke). */
  async replaceToken(id: string, token: string): Promise<PublicConnection> {
    const crypt = this.crypt;
    const q = this.#host.scope.connections;
    const existing = await q.getSecret(id);
    if (!existing) throw new CfConnectionError('missing', id);
    if (existing.auth_type !== 'token') throw new ConnectionInputError('only pasted-token connections take a new token; reconnect OAuth connections through OAuth');
    const cf = new CfClient(token, { fetch: this.#host.fetch });
    try {
      const v = await cf.verifyToken();
      if (v.status !== 'active') throw new ConnectionInputError(`this API token is not active (${v.status})`);
    } catch (e) {
      if (e instanceof CfAuthError) throw new ConnectionInputError('Cloudflare did not accept this API token');
      throw e;
    }
    await this.#assertSameAccount(id, existing.cf_account_id, cf);
    await q.reactivate(id, await crypt.seal({ access: token }, envelopeAad(this.#host.accountId, id)), null);
    this.invalidate();
    return (await this.get(id))!;
  }

  /**
   * A reconnect must reach the Cloudflare account the connection was made for: its allow-list and linked domains
   * belong to that account. Known accounts = the recorded one plus the accounts of the allow-listed zones; the new
   * grant has to see all of them. If nothing is known (never recorded, no zones) there is nothing to compare.
   */
  async #assertSameAccount(id: string, recorded: string | null, cf: CfClient): Promise<void> {
    const known = new Set<string>(recorded ? [recorded] : []);
    for (const z of await this.#host.scope.connections.zones(id)) if (z.cf_account_id) known.add(z.cf_account_id);
    if (known.size === 0) return;
    let visible: Set<string>;
    try {
      visible = new Set((await cf.listAccounts()).map(a => a.id));
    } catch {
      throw new ConnectionInputError('could not confirm that this is the same Cloudflare account; reconnect again in a moment', 409, 'cf_account_unverified');
    }
    if (![...known].every(a => visible.has(a))) {
      throw new ConnectionInputError('this authorization is for a different Cloudflare account than the one this connection was made for; add it as a new connection instead', 409, 'cf_account_mismatch');
    }
  }

  async #soleAccount(cf: CfClient): Promise<{ id: string; name: string } | null> {
    try {
      const accounts = await cf.listAccounts();
      return accounts.length === 1 ? accounts[0] : null;
    } catch {
      return null; // a token without Account:Read still works for zones
    }
  }

  // ── Disconnecting ──────────────────────────────────────────

  /**
   * Remove a connection. OAuth: revoke the grant at Cloudflare first (best effort; the local row goes either way).
   * Pasted tokens cannot be revoked from here: the owner revokes them in the Cloudflare dashboard.
   * Returns whether Cloudflare confirmed the revocation (null: nothing to revoke).
   */
  async disconnect(id: string): Promise<{ revokedRemote: boolean | null; unlinkedDomains: number } | null> {
    const q = this.#host.scope.connections;
    const row = await q.getSecret(id);
    if (!row) return null;
    let revokedRemote: boolean | null = null;
    const cfg = row.auth_type === 'oauth' ? safeOauthConfig(this.#host.env) : null;
    if (row.auth_type === 'oauth') {
      revokedRemote = false;
      if (cfg) {
        try {
          const m = await this.crypt.open(row.token_envelope, envelopeAad(this.#host.accountId, id));
          const first = m.refresh() ? await revokeToken(cfg, m.refresh()!, 'refresh_token', this.#fetch) : false;
          const second = await revokeToken(cfg, m.access(), 'access_token', this.#fetch);
          revokedRemote = first || second;
        } catch { /* no key, or an envelope that does not open: nothing to revoke with */ }
      }
    }
    const unlinkedDomains = await q.linkedDomainCount(id);
    await q.delete(id);
    this.invalidate();
    return { revokedRemote, unlinkedDomains };
  }

  // ── Zones ──────────────────────────────────────────────────

  /** Every active zone the connection's token can see, with whether Inbox Angel may manage it. */
  async availableZones(id: string): Promise<{ id: string; name: string; allowed: boolean; accountId?: string }[]> {
    const cf = await this.#setupClient(id);
    const allowed = new Set((await this.#host.scope.connections.zones(id)).map(z => z.zone_id));
    return (await cf.listZones()).map(z => ({ id: z.id, name: z.name.toLowerCase(), allowed: allowed.has(z.id), accountId: z.account?.id }));
  }

  /** Replace the allow-list. Every id must be a zone the token can actually see (names come from Cloudflare, not the caller). */
  async setAllowedZones(id: string, zoneIds: string[]): Promise<{ id: string; name: string }[]> {
    const bad = zoneIds.filter(z => !ZONE_ID.test(z));
    if (bad.length) throw new ConnectionInputError('zone_ids must be Cloudflare zone ids (32 hex characters)');
    const visible = new Map((await this.availableZones(id)).map(z => [z.id, z]));
    const unknown = zoneIds.filter(z => !visible.has(z));
    if (unknown.length) throw new ConnectionInputError(`not a zone this Cloudflare connection can see: ${unknown.join(', ')}`);
    const unique = [...new Set(zoneIds)];
    if (!(await this.#host.scope.connections.setZones(id, unique.map(z => ({ zone_id: z, zone_name: visible.get(z)!.name, cf_account_id: visible.get(z)!.accountId }))))) throw new CfConnectionError('missing', id);
    this.invalidate();
    return unique.map(z => ({ id: z, name: visible.get(z)!.name }));
  }

  // ── Using ──────────────────────────────────────────────────

  /**
   * The client to act on a connection's zones: allow-listed, refreshing, and typed-failing.
   * Throws CfConnectionError for a broken, revoked or missing connection.
   */
  clientFor(id: string): Promise<CfClient> {
    let hit = this.#clients.get(id);
    if (!hit) {
      hit = this.#build(id, true);
      this.#clients.set(id, hit);
      hit.catch(() => { if (this.#clients.get(id) === hit) this.#clients.delete(id); });
    }
    return hit;
  }

  /** A client with the token but no allow-list: only for choosing the allow-list. */
  async #setupClient(id: string): Promise<CfClient> {
    return this.#build(id, false);
  }

  async #build(id: string, restricted: boolean): Promise<CfClient> {
    const q = this.#host.scope.connections;
    const row = await q.getSecret(id);
    if (!row) throw new CfConnectionError('missing', id);
    if (row.status !== 'active') throw new CfConnectionError(row.status, id, row.label);
    this.crypt; // surface a missing key now, not mid-request

    const policy: CfPolicy | undefined = restricted ? policyFor(id, await q.zones(id), row.cf_account_id) : undefined;

    const now = this.#now;
    if (!row.last_used_at || now - row.last_used_at > LAST_USED_THROTTLE_SECONDS) await q.markUsed(id, now).catch(() => {});

    return new CfClient(async () => (await this.#current(id)).material.access(), {
      fetch: this.#host.fetch,
      policy,
      onUnauthorized: () => this.#unauthorized(id),
    });
  }

  /** The opened token of a connection, refreshed first if it has expired. */
  async #current(id: string): Promise<Opened> {
    let hit = this.#opened.get(id);
    if (!hit) {
      hit = this.#open(id);
      this.#opened.set(id, hit);
      hit.catch(() => { if (this.#opened.get(id) === hit) this.#opened.delete(id); });
    }
    const opened = await hit;
    if (opened.material.refresh() && opened.material.expired(this.#now)) return this.#refresh(id, opened);
    return opened;
  }

  async #open(id: string): Promise<Opened> {
    const q = this.#host.scope.connections;
    const row = await q.getSecret(id);
    if (!row) throw new CfConnectionError('missing', id);
    if (row.status !== 'active') throw new CfConnectionError(row.status, id, row.label);
    const aad = envelopeAad(this.#host.accountId, id);
    let material: TokenMaterial;
    try {
      material = await this.crypt.open(row.token_envelope, aad);
    } catch (e) {
      // This is the operator's problem (the key was changed or dropped), not the customer's: the connection is
      // not marked broken and nobody is alerted. Every call through it fails with a 503 until the key is restored.
      console.error(`[connections] ${this.#host.accountId}: stored credentials of connection ${id} cannot be opened with the configured key (${e instanceof Error ? e.name : 'error'}); check the server key setting`);
      throw e;
    }
    let envelope = row.token_envelope;
    // Sealed under a retired key: move it to the current one while we hold the plaintext.
    if (!this.crypt.isCurrent(envelope)) {
      const resealed = await this.crypt.seal(material, aad);
      if (await q.swapEnvelope(id, envelope, resealed).catch(() => false)) envelope = resealed;
    }
    return { envelope, material };
  }

  /** Refresh once; concurrent callers share the one in-flight refresh. */
  #refresh(id: string, from: Opened): Promise<Opened> {
    let run = this.#refreshing.get(id);
    if (!run) {
      run = this.#doRefresh(id, from).finally(() => this.#refreshing.delete(id));
      this.#refreshing.set(id, run);
    }
    return run;
  }

  async #doRefresh(id: string, from: Opened): Promise<Opened> {
    const q = this.#host.scope.connections;
    const row = await q.getSecret(id);
    if (!row) throw new CfConnectionError('missing', id);
    const refreshToken = from.material.refresh();
    const cfg = safeOauthConfig(this.#host.env);
    if (!refreshToken || !cfg) {
      await this.#break(id, row.label, refreshToken ? 'OAuth is no longer configured on this deployment' : 'the token expired and there is no refresh token');
      throw new CfConnectionError('broken', id, row.label);
    }

    const aad = envelopeAad(this.#host.accountId, id);
    let tokens: OAuthTokens;
    try {
      tokens = await refreshTokens(cfg, refreshToken, this.#fetch, this.#now);
    } catch (e) {
      if (!(e instanceof OAuthError) || !e.permanent) throw e; // Cloudflare unreachable: say nothing about the grant
      // Refresh tokens are single-use: another isolate may have refreshed first. Give it a moment to
      // store its result, and use that instead of declaring the connection broken.
      for (const wait of [0, 300, 700]) {
        if (wait) await new Promise(r => setTimeout(r, wait));
        const current = await q.getSecret(id);
        if (current && current.status === 'active' && current.token_envelope !== from.envelope) {
          const material = await this.crypt.open(current.token_envelope, aad).catch(() => null);
          if (material && !material.expired(this.#now)) return this.#remember(id, { envelope: current.token_envelope, material });
        }
      }
      await this.#break(id, row.label, 'Cloudflare refused to refresh the access token: reconnect this account');
      throw new CfConnectionError('broken', id, row.label);
    }

    const envelope = await this.crypt.seal(tokens.material, aad);
    if (!(await q.swapEnvelope(id, from.envelope, envelope))) {
      // Lost the race to another writer: theirs is the valid one now.
      const current = await q.getSecret(id);
      if (current) {
        const material = await this.crypt.open(current.token_envelope, aad);
        return this.#remember(id, { envelope: current.token_envelope, material });
      }
      throw new CfConnectionError('missing', id);
    }
    return this.#remember(id, { envelope, material: tokens.material });
  }

  #remember(id: string, opened: Opened): Opened {
    this.#opened.set(id, Promise.resolve(opened));
    return opened;
  }

  /** Cloudflare answered 401. OAuth: one forced refresh, then the request is retried. Otherwise the connection is broken. */
  async #unauthorized(id: string): Promise<string | null> {
    const row = await this.#host.scope.connections.getSecret(id);
    if (!row) throw new CfConnectionError('missing', id);
    if (row.auth_type === 'oauth') {
      const opened = await this.#current(id);
      if (opened.material.refresh()) {
        const fresh = await this.#refresh(id, opened);
        if (fresh.material.access() !== opened.material.access()) return fresh.material.access();
      }
    }
    await this.#break(id, row.label, 'Cloudflare rejected the token (revoked or expired): reconnect this account');
    throw new CfConnectionError('broken', id, row.label);
  }

  async #break(id: string, label: string, detail: string): Promise<void> {
    const changed = await this.#host.scope.connections.markBroken(id, detail);
    this.invalidate();
    if (changed && this.#host.onBroken) {
      try { await this.#host.onBroken({ id, label, detail }); } catch { /* an alert that fails must not mask the real error */ }
    }
  }
}

function cleanLabel(label: unknown): string | undefined {
  const s = typeof label === 'string' ? label.trim().slice(0, 80) : '';
  return s || undefined;
}

function safeOauthConfig(env: OAuthEnv) {
  try { return oauthConfig(env); } catch { return null; }
}

const ZONE_ID = /^[0-9a-f]{32}$/;

/**
 * The allow-list as a CfClient policy. Refuses, without sending anything:
 *  - any `/zones/<id>/…` whose id is not a well-formed, allowed zone id (reads too);
 *  - `GET /zones` (discovery) and name lookups of zones that are not allowed: discovery is the setup-only path;
 *  - `/accounts/<id>/…` of any Cloudflare account not derived from the connection: its recorded account and the
 *    accounts of its allowed zones. When none is known, every `/accounts/*` call is refused.
 */
function policyFor(connectionId: string, zones: CfConnectionZone[], cfAccountId: string | null): CfPolicy {
  const allowed = new Set(zones.map(z => z.zone_id).filter(z => ZONE_ID.test(z)));
  const names = new Set(zones.map(z => z.zone_name.toLowerCase()));
  const accounts = new Set<string>([...(cfAccountId ? [cfAccountId] : []), ...zones.flatMap(z => (z.cf_account_id ? [z.cf_account_id] : []))]);
  return {
    request(_method, path, query) {
      if (path === '/zones') {
        const name = typeof query?.name === 'string' ? query.name.toLowerCase() : undefined;
        if (!name || !names.has(name)) throw new CfZoneNotAllowedError(name ?? '(zone list)', connectionId);
        return;
      }
      const zone = path.match(/^\/zones\/([^/?]+)/)?.[1];
      if (zone !== undefined && !(ZONE_ID.test(zone) && allowed.has(zone))) throw new CfZoneNotAllowedError(zone, connectionId);
      const account = path.match(/^\/accounts(?:\/([^/?]+))?/)?.[1];
      if (path.startsWith('/accounts') && (account === undefined || !accounts.has(account))) throw new CfZoneNotAllowedError(account ?? '(account list)', connectionId, 'account');
    },
    lookup(name) {
      return names.has(name.toLowerCase());
    },
    zone(z) {
      if (!allowed.has(z.id)) throw new CfZoneNotAllowedError(z.name, connectionId);
    },
  };
}
