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
import { baseUrl, oauthProviders, trustedOrigins, type AuthEnv } from './config';
import { sendPasswordResetEmail } from './mail';
import { d1RateLimitStorage } from './rate-limit';
import { authSecret } from './secret';
import { assertMaySignUp, provisionUser, type SignupIntent } from './signup-policy';

export const AUTH_BASE_PATH = '/api/auth';

/** 30 days, rolling. */
const SESSION_SECONDS = 30 * 24 * 3600;

export async function createAuth(
  env: AuthEnv,
  request: Request,
  opts: { intent?: SignupIntent; ctx?: Pick<ExecutionContext, 'waitUntil'> } = {},
) {
  const intent: SignupIntent = opts.intent ?? { kind: 'external' };
  const origin = baseUrl(env, new URL(request.url).origin);
  const db = env.DB as D1Database;
  const providers = oauthProviders(env);

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

    socialProviders: providers,

    session: { expiresIn: SESSION_SECONDS, updateAge: 24 * 3600 },

    user: { modelName: 'user' },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertMaySignUp(env, intent, user.email.toLowerCase());
          },
          after: async (user) => {
            await provisionUser(env, intent, { id: user.id, email: user.email.toLowerCase(), name: user.name });
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
      backgroundTasks: opts.ctx ? { handler: (p: Promise<unknown>) => opts.ctx!.waitUntil(p) } : undefined,
    },
  });
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
