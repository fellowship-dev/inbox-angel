import { it, expect } from 'vitest';
import { makeEnv, call, type TestDb } from './helpers';
it('one installer capability can claim exactly one owner under concurrent setup', async () => {
 const env = makeEnv();
 const responses = await Promise.all(['alice@example.com','bob@example.com'].map(email => call(env, 'POST', '/api/auth/setup', { body: { email, password: 'unique-test-password' } })));
 expect(responses.map(r=>r.status).filter(s=>s===201)).toHaveLength(1);
 const db = env.DB as unknown as TestDb;
 expect(db.sqlite.prepare("SELECT COUNT(*) n FROM memberships WHERE role='owner'").get()).toEqual({ n: 1 });
 expect(db.sqlite.prepare("SELECT value FROM settings WHERE key='bootstrap_consumed'").get()).toEqual({ value: 'true' });
 const replay = await call(env,'POST','/api/auth/setup',{body:{email:'third@example.com',password:'unique-test-password'}});
 expect(replay.status).toBe(409);
});
