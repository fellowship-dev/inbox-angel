import { describe, it, expect } from 'vitest';
import { detectDnsHost, DNS_HOSTS } from '../src/dns-hosts';

describe('detectDnsHost', () => {
  it.each([
    [['ns1.cloudflare.com'], 'cloudflare', 'Cloudflare'],
    [['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'], 'cloudflare', 'Cloudflare'],
    [['ns-1.awsdns-01.org'], 'route53', 'AWS Route 53'],
    [['ns01.domaincontrol.com'], 'godaddy', 'GoDaddy'],
    [['dns1.registrar-servers.com'], 'namecheap', 'Namecheap'],
    [['ns1.vercel-dns.com'], 'vercel', 'Vercel'],
    [['dns1.p01.nsone.net'], 'ns1', 'NS1'],
    [['ns1.digitalocean.com'], 'digitalocean', 'DigitalOcean'],
    [['ns1-01.azure-dns.com'], 'azure-dns', 'Azure DNS'],
    [['ns-cloud-a1.googledomains.com'], 'google-cloud-dns', 'Google Cloud DNS'],
    [['curitiba.porkbun.com'], 'porkbun', 'Porkbun'],
    [['ns-1.gandi.net'], 'gandi', 'Gandi'],
    [['ns1.dnsimple.com'], 'dnsimple', 'DNSimple'],
    [['ns1.hover.com'], 'hover', 'Hover'],
  ])('%j → %s', (ns, id, label) => {
    expect(detectDnsHost(ns)).toEqual({ id, label });
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(detectDnsHost(['NS1.CloudFlare.com.']).id).toBe('cloudflare');
  });

  it('an unrecognised or empty NS set is unknown', () => {
    expect(detectDnsHost(['ns1.example-dns.net'])).toEqual({ id: 'unknown', label: 'Unknown' });
    expect(detectDnsHost([])).toEqual({ id: 'unknown', label: 'Unknown' });
  });

  it('ids are unique', () => {
    const ids = DNS_HOSTS.map(h => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
