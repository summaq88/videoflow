/**
 * A provider adapter describes one platform. Each lives in its own file so a
 * platform can be fixed or extended without touching the others.
 *
 *  id          stable key used in the API and database
 *  name        display name
 *  hosts       domains this adapter owns (sub-domains match too)
 *  normalize   tidy the URL (strip tracking params, expand short forms)
 *  cleanFilter optional yt-dlp format filter preferring the platform's own
 *              clean (no overlay) rendition when the platform provides one
 *  notes       what users should know (shown in the preview)
 */
export function defineProvider(p) {
  return {
    hosts: [],
    normalize: (u) => u,
    cleanFilter: '',
    notes: '',
    errorHints: {},
    ...p,
    matches(url) {
      const h = url.hostname.toLowerCase().replace(/^www\./, '');
      return this.hosts.some((d) => h === d || h.endsWith('.' + d));
    },
  };
}

/** Remove common tracking parameters. */
export function stripTracking(u, keep = []) {
  const out = new URL(u.href);
  for (const k of [...out.searchParams.keys()]) {
    if (keep.includes(k)) continue;
    if (/^(utm_|fbclid|gclid|igsh|igshid|si$|feature$|_r$|_t$|is_from_webapp|sender_device|share_|ref)/i.test(k)) {
      out.searchParams.delete(k);
    }
  }
  return out;
}
