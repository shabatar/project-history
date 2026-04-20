/** Build links into a YouTrack instance given a base URL. */

export function userUrl(base: string | null | undefined, login: string | null | undefined): string | null {
  if (!base || !login) return null;
  return `${base.replace(/\/+$/, '')}/users/${encodeURIComponent(login)}`;
}

export function issueUrl(base: string | null | undefined, issueId: string): string | null {
  if (!base || !issueId) return null;
  return `${base.replace(/\/+$/, '')}/issue/${encodeURIComponent(issueId)}`;
}

/** Extract the YouTrack origin from any URL that points to the same instance. */
export function baseFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/^(https?:\/\/[^/]+)/);
  return m ? m[1] : null;
}
