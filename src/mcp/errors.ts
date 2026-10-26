import { AccessDenied } from '../access/policy';
export class ToolError extends Error { constructor(readonly code: 'forbidden' | 'invalid_input' | 'not_found' | 'unavailable', message: string) { super(message); } }
export function toolFailure(error: unknown) {
 const status = (error as { status?: number })?.status;
 const code = error instanceof ToolError ? error.code : error instanceof AccessDenied || (status === 403 || status === 409) ? 'forbidden' : status === 404 ? 'not_found' : status === 400 ? 'invalid_input' : 'unavailable';
 const message = error instanceof ToolError || error instanceof AccessDenied || status === 400 || status === 404 || status === 409 ? (error as Error).message : 'Operation unavailable; retry or inspect the installation status.';
 const structuredContent = { schema: 'inbox-angel-tool/v1' as const, summary: message, data: {}, evidence: [], error: { code, message } };
 return { isError: true, content: [{ type: 'text' as const, text: message }], structuredContent };
}
