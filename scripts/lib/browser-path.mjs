import { existsSync } from 'node:fs';

/**
 * Which Chrome/Chromium the browser scripts drive. Order: the developer's own PUPPETEER_EXECUTABLE_PATH, the Linux sandbox's
 * Chromium, a normal Chrome/Edge install (Windows, macOS, Linux), then the Chrome that Puppeteer downloaded with `npm ci`.
 */
export async function chromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  try {
    const { default: puppeteer } = await import('puppeteer');
    const p = puppeteer.executablePath();
    if (p && existsSync(p)) return p;
  } catch { /* puppeteer not installed */ }
  throw new Error('No Chrome/Chromium found. Install Chrome, or set PUPPETEER_EXECUTABLE_PATH to its full path (e.g. "C:/Program Files/Google/Chrome/Application/chrome.exe").');
}
