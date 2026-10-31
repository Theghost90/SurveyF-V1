/**
 * One mailbox, one account. Several providers ignore dots and "+tags" in the local part, so john.doe+shop@gmail.com, johndoe@gmail.com and
 * j.o.h.n.d.o.e@googlemail.com are all the same inbox. Folding them stops one person opening many accounts (to get around the Explore cap).
 *
 * Only providers known to behave that way are folded: wrongly merging two different people on an unknown domain (where "a+b@" may be a real, separate
 * mailbox) would be worse than letting an alias through.
 */
const PLUS_ADDRESSING = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.fr', 'live.com', 'live.fr', 'msn.com', 'icloud.com', 'me.com', 'mac.com',
  'protonmail.com', 'proton.me', 'pm.me', 'fastmail.com', 'fastmail.fm',
]);
const IGNORES_DOTS = new Set(['gmail.com', 'googlemail.com']);

export function canonicalEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  if (PLUS_ADDRESSING.has(domain)) local = local.split('+')[0]!;
  if (IGNORES_DOTS.has(domain)) { local = local.replace(/\./g, ''); domain = 'gmail.com'; }
  return `${local}@${domain}`;
}

/** "j***@gmail.com": enough for the owner to recognise their own address in a page or a log line. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}
