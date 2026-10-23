// Turnstile never leaves the test process: the token 'ok' passes, anything else fails.
import { vi } from 'vitest';

vi.mock('../../src/auth/turnstile', () => ({ verifyTurnstile: async (token: string) => token === 'ok' }));
