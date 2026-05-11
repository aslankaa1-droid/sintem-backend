// Structured JSON logger. Cloudflare Logs treats stdout JSON as structured.
// PII guard: never include username, first_name, или текст сообщения в payload.

export interface LogPayload {
  event: string;
  level?: 'info' | 'warn' | 'error';
  user_id?: number;
  agent_id?: string;
  latency_ms?: number;
  error?: string;
  [k: string]: unknown;
}

export function log(payload: LogPayload): void {
  const out = { ts: Date.now(), level: payload.level ?? 'info', ...payload };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out));
}
