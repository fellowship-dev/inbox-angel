// Better Auth on D1, via its Drizzle adapter on @inbox-angel/db.
//
//  - email + password always; GitHub / Google only when their client id + secret are set
//  - sessions, credentials and reset tokens in D1 (migration 0013)
//  - password hashing stays PBKDF2 (src/api/password.ts), so hashes from before Better Auth verify unchanged
//  - one instance per request: hooks close over the request's sign-up intent and waitUntil
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins';
import { betterAuthSchema, getDb, globalQueries } from '@inbox-angel/db';
import { hashPassword, verifyPassword } from '../api/password';
import { baseUrl, isSaas, oauthProviders, trustedOrigins, type AuthEnv } from './config';
import { sendPasswordResetEmail, sendVerificationEmail } from './mail';
import { d1RateLimitStorage } from './rate-limit';
import { authSecret } from './secret';
import { assertMaySignUp, provisionUser, type SignupIntent } from './signup-policy';

export const AUTH_BASE_PATH = '/api/auth';

/** 30 days, rolling. */
const SESSION_SECONDS = 30 * 24 * 3600;

export async function createAuth(
  env: AuthEnv,
  request: Request,
  opts: { intent?: SignupIntent; ctx?: Pick<ExecutionContext, 'waitUntil'>; onEmailVerified?: (user: { id: string; email: string }) => void } = {},
) {
  const intent: SignupIntent = opts.intent ?? { kind: 'external' };
  const origin = baseUrl(env, new URL(request.url).origin);
  const db = env.DB as D1Database;
  const providers = oauthProviders(env);
  const saas = isSaas(env);

  return betterAuth({
    appName: 'InboxAngel',
    baseURL: origin,
    basePath: AUTH_BASE_PATH,
    secret: await authSecret(env),
    trustedOrigins: trustedOrigins(env, new URL(request.url).origin),
    database: drizzleAdapter(getDb(db), { provider: 'sqlite', schema: betterAuthSchema }),
    plugins: [bearer()],

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // Hosted: no session until the mailbox is proven (sign-up and sign-in both send the verification email).
      // Self-host: the owner is verified at setup, teammates arrive by invite, and outbound mail may not reach them.
      requireEmailVerification: saas,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 3600,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(password, hash),
      },
      sendResetPassword: async ({ user, token }) => {
        await sendPasswordResetEmail(env, user, `${origin}/#/reset/${token}`);
      },
    },

    emailVerification: {
      sendOnSignUp: saas,
      sendOnSignIn: saas,
      // Verifying never signs anyone in: whoever typed the password at sign-up is not necessarily the mailbox owner, so
      // verification becomes a set-password step (see the /verify-email route in routes.ts).
      autoSignInAfterVerification: false,
      afterEmailVerification: async (user) => { opts.onEmailVerified?.({ id: user.id, email: user.email }); },
      expiresIn: 24 * 3600,
      sendVerificationEmail: async ({ user, url }) => {
        await sendVerificationEmail(env, user, url);
      },
    },

    socialProviders: providers,

    // Accounts are linked only when both emails are verified: the local account's (so a password registered by
    // someone else for this address cannot be inherited by the real owner's Google/GitHub login) and the provider's
    // (no provider is trusted blindly).
    account: { accountLinking: { enabled: true, requireLocalEmailVerified: true, trustedProviders: [] } },

    session: { expiresIn: SESSION_SECONDS, updateAge: 24 * 3600 },

    user: { modelName: 'user' },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertMaySignUp(env, intent, user.email.toLowerCase(), user.emailVerified === true);
          },
          after: async (user) => {
            await provisionUser(env, intent, { id: user.id, email: user.email.toLowerCase(), name: user.name, emailVerified: user.emailVerified === true });
          },
        },
      },
      account: {
        create: {
          // The first time an OAuth login attaches to a user, every session they already had ends: whoever held them
          // (e.g. the registrant of a password for this address) no longer has access.
          after: async (account) => {
            if (account.providerId !== 'credential') await globalQueries(db).sessions.revokeAll(account.userId);
          },
        },
      },
      session: {
        create: {
          after: async (session) => {
            await globalQueries(db).users.touchLogin(session.userId);
          },
        },
      },
    },

    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-in/social': { window: 60, max: 20 },
        '/sign-up/email': { window: 3600, max: 10 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/reset-password': { window: 3600, max: 10 },
        '/get-session': false,
      },
      customStorage: d1RateLimitStorage(db),
    },

    advanced: {
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      // The browser session cookie: HttpOnly, SameSite=Lax, and Secure whenever the dashboard is served over https.
      useSecureCookies: origin.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      backgroundTasks: opts.ctx ? { handler: (p: Promise<unknown>) => opts.ctx!.waitUntil(p) } : undefined,
    },
  });
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
