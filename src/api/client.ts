// In-memory Bearer token fallback + HttpOnly cookie persistence (never stored in localStorage/sessionStorage)
let sessionToken: string | null = null;

export function setSessionToken(token: string | null) {
  sessionToken = token;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

export async function apiFetch<T = unknown>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  headers.set('X-Requested-With', 'NAGAR-AI');
  if (sessionToken) {
    headers.set('Authorization', `Bearer ${sessionToken}`);
  }
  if (!(options.body instanceof FormData) && !headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  const resp = await fetch(url, {
    ...options,
    credentials: 'include',
    headers,
  });

  const contentType = resp.headers.get('content-type') || '';
  if (!resp.ok) {
    let errMsg = `Request failed (${resp.status})`;
    if (contentType.includes('application/json')) {
      const errBody = (await resp.json().catch(() => ({}))) as { error?: string };
      if (errBody.error) errMsg = errBody.error;
    } else {
      const txt = await resp.text().catch(() => '');
      if (txt) errMsg = txt.slice(0, 180);
    }
    const err = new Error(errMsg) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }

  if (contentType.includes('application/json')) {
    return (await resp.json()) as T;
  }
  return (await resp.text()) as unknown as T;
}
