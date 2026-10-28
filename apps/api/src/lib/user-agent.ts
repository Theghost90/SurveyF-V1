/** A deliberately coarse reading of a User-Agent: "Chrome · Windows". Enough for a "new sign-in" notice and the session list, not a fingerprint. */
export function describeAgent(ua: string | undefined | null): { browser: string; system: string; label: string } {
  const s = ua ?? '';
  const browser = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /SamsungBrowser/.test(s) ? 'Samsung Internet' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\/|CriOS/.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : s ? 'Browser' : 'Unknown browser';
  const system = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad|iOS/.test(s) ? 'iOS' : /Mac OS X|Macintosh/.test(s) ? 'macOS'
    : /CrOS/.test(s) ? 'ChromeOS' : /Linux/.test(s) ? 'Linux' : s ? 'Unknown system' : 'Unknown system';
  return { browser, system, label: `${browser} · ${system}` };
}
