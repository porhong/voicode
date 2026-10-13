import type { AgentInfoResponse, PairRequest, PairResponse } from '@voicecode/protocol';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
  ) {
    super(reason ?? `HTTP ${status}`);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = (await res.json().catch(() => ({}))) as T & { reason?: string; error?: string };
  if (!res.ok) throw new ApiError(res.status, body.reason ?? body.error);
  return body;
}

export const api = {
  info: () => request<AgentInfoResponse>('/api/info'),
  pair: (body: PairRequest) =>
    request<PairResponse>('/api/pair', { method: 'POST', body: JSON.stringify(body) }),
  unpair: () => request<{ ok: true }>('/api/unpair', { method: 'POST', body: '{}' }),
};

export function pairingErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.reason) {
      case 'mismatch':
        return 'That code is not right. Check the code shown in the terminal.';
      case 'expired':
      case 'no_code':
        return 'This code has expired. Run `voicecode-agent pair` for a new one.';
      case 'locked':
        return 'Too many wrong attempts. Run `voicecode-agent pair` for a new code.';
      case 'malformed':
        return 'Enter the 6-digit code.';
    }
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
  }
  return 'Could not reach the agent.';
}
