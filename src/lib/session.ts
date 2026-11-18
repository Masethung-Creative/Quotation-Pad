/**
 * The site sits behind Cloudflare Access (login by email one-time PIN). The app itself has
 * no login code: it only notices when the Access session has expired and asks the user to
 * log in again. /session.json is a tiny static file that Access lets through only with a
 * valid session; without one, Access answers with a redirect to its login page.
 */

export type SessionState = 'ok' | 'expired' | 'unknown';

export async function checkSession(): Promise<SessionState> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return 'unknown';
  try {
    const res = await fetch('/session.json', { cache: 'no-store', redirect: 'manual', credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) return 'expired';
    if (!res.ok) return 'unknown';
    if (!(res.headers.get('content-type') ?? '').includes('json')) return 'expired';
    const body = (await res.json().catch(() => null)) as { app?: string } | null;
    return body?.app === 'quotation-pad' ? 'ok' : 'expired';
  } catch {
    // Offline or the network dropped: keep working from the device.
    return 'unknown';
  }
}

/** Full page load of a path the service worker never answers, so Cloudflare Access can show its login. */
export function goToLogin(): void {
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
}
