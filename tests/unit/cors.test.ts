import { describe, expect, it } from 'vitest';
import { corsOrigin } from '../../src/app';

function allowed(list: string, origin: string | undefined): boolean {
  let result = false;
  corsOrigin(list)(origin, (_err, allow) => {
    result = !!allow;
  });
  return result;
}

describe('CORS allow-list (deploy-mistake tolerant)', () => {
  it('matches exact origins and ignores trailing slashes, spaces and case', () => {
    const list = ' https://airorecruit.vercel.app/ , http://localhost:5173';
    expect(allowed(list, 'https://airorecruit.vercel.app')).toBe(true);
    expect(allowed(list, 'https://AiroRecruit.vercel.app')).toBe(true);
    expect(allowed(list, 'http://localhost:5173')).toBe(true);
    expect(allowed(list, 'https://evil.example')).toBe(false);
  });

  it('supports wildcard subdomains for preview deployments, one label only', () => {
    const list = 'https://*.vercel.app';
    expect(allowed(list, 'https://airorecruit-git-main-team.vercel.app')).toBe(true);
    expect(allowed(list, 'https://a.b.vercel.app')).toBe(false);
    expect(allowed(list, 'https://vercel.app.evil.example')).toBe(false);
    expect(allowed(list, 'http://x.vercel.app')).toBe(false);
  });

  it('allows requests without an Origin header and honours a bare *', () => {
    expect(allowed('https://only.example', undefined)).toBe(true);
    expect(allowed('*', 'https://anything.example')).toBe(true);
  });
});
