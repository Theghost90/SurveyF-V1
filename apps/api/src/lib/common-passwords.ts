/**
 * Passwords people pick first, so attackers try first. Only entries of 10+ characters matter here (the minimum length is 10); shorter ones are kept
 * out of the way by that rule. The list is a floor, not a defence: the breached-password check (lib/password.ts) covers the long tail.
 * It leans on what Cameroonian and French-speaking users type as well as the English classics.
 */
const COMMON = [
  '1234567890', '0123456789', '12345678910', '1234567891', '0987654321', '1111111111', '0000000000', '1212121212', '123456789a', 'a123456789',
  'password12', 'password123', 'password1234', 'password01', 'password11', 'password1!', 'passw0rd123', 'p@ssword123', 'p@ssw0rd123', 'mypassword',
  'mypassword1', 'mypassword123', 'letmein123', 'letmein1234', 'welcome123', 'welcome1234', 'welcome@123', 'qwertyuiop', 'qwertyuiop1', 'qwerty1234',
  'qwerty12345', 'qwerty123456', 'qwertyuiop123', '1qaz2wsx3e', '1q2w3e4r5t', '1q2w3e4r5t6y', 'asdfghjkl1', 'asdfghjklq', 'zxcvbnm123', 'zxcvbnm1234',
  'azertyuiop', 'azertyuiop1', 'azertyuiop123', 'azerty1234', 'azerty12345', 'azerty123456', 'qsdfghjklm', 'wxcvbn1234', 'motdepasse', 'motdepasse1',
  'motdepasse123', 'motdepasse12', 'monmotdepasse', 'monmotdepasse1', 'bonjour123', 'bonjour1234', 'bonjour2024', 'bonjour2025', 'bonjour2026',
  'iloveyou12', 'iloveyou123', 'iloveyou1234', 'jetaime123', 'jetaime1234', 'abcdefghij', 'abcdefghi1', 'abcd123456', 'abcd1234567', 'abc1234567',
  'abcabcabc1', 'aaaaaaaaaa', 'aaaaaaaa11', 'sunshine12', 'sunshine123', 'superman12', 'superman123', 'princess12', 'princess123', 'football12',
  'football123', 'baseball12', 'baseball123', 'starwars12', 'starwars123', 'whatever12', 'whatever123', 'trustno111', 'trustno1234', 'dragon1234',
  'master1234', 'monkey1234', 'shadow1234', 'michael123', 'jordan2345', 'charlie123', 'jennifer12', 'jessica123', 'daniel1234', 'matthew123',
  'cameroun12', 'cameroun123', 'cameroon12', 'cameroon123', 'cameroun237', 'cameroon237', 'douala1234', 'douala12345', 'yaounde123', 'yaounde1234',
  'afrique123', 'africa1234', 'africa12345', 'bamenda123', 'bafoussam1', 'garoua1234', 'bertoua123', 'kribi12345', 'limbe12345', 'buea123456',
  '2376770000', '23767700001', '237677000000', '237600000000', '6770000000', '6777777777', '6999999999', '6555555555', '6666666666', '6888888888',
  'surveyflow', 'surveyflow1', 'surveyflow12', 'surveyflow123', 'surveyflow2026', 'survey1234', 'survey12345', 'whatsapp123', 'whatsapp1234', 'whatsapp2026',
  'boulangerie', 'boulangerie1', 'boulangerie123', 'akwa123456', 'admin12345', 'admin123456', 'administrator', 'administrator1', 'root123456', 'test123456',
  'test1234567', 'testtest123', 'changeme123', 'changeme1234', 'default1234', 'guest12345', 'user123456', 'login12345', 'access12345', 'secret1234',
  'secret12345', 'secret123456', 'passpass12', 'passpass123', 'pass123456', 'pass1234567', 'pa$$word123', 'pa55word123', 'p4ssword12', 'p4ssw0rd123',
  'qazwsxedc1', 'qazwsxedcrfv', 'zaq12wsxcde', 'zaq1zaq1zaq', '1qazxsw23edc', 'q1w2e3r4t5', 'q1w2e3r4t5y6', 'qweasdzxc1', 'qweasdzxc123', 'asdf123456',
  'asdfasdf12', 'asdfghjk12', 'qwertyqwerty', 'qwertyasdf', 'poiuytrewq', 'lkjhgfdsa1', 'mnbvcxz123', 'trewq12345', 'googlegoogle', 'facebook123',
  'facebook1234', 'instagram12', 'instagram123', 'youtube1234', 'linkedin123', 'twitter1234', 'netflix1234', 'tiktok12345', 'snapchat123', 'telegram123',
  'orange12345', 'orangemoney1', 'mtnmomo1234', 'mtnmomo123', 'momo123456', 'mobilemoney', 'mobilemoney1', 'money12345', 'money123456', 'argent1234',
  'chocolat123', 'chocolat12', 'soleil1234', 'soleil12345', 'doudou1234', 'doudou12345', 'liberte123', 'amour12345', 'amour123456', 'famille1234',
  'france2024', 'france2025', 'france2026', 'paris12345', 'marseille1', 'azerty2024', 'azerty2025', 'azerty2026', 'password2024', 'password2025',
  'password2026', 'welcome2024', 'welcome2025', 'welcome2026', 'admin2024', 'admin2025', 'admin2026', 'qwerty2024', 'qwerty2025', 'qwerty2026',
  'monkey12345', 'dragon12345', 'master12345', 'shadow12345', 'freedom123', 'freedom1234', 'killer1234', 'hunter1234', 'ranger1234', 'buster1234',
];

const SET = new Set(COMMON);

/** Obvious structure: one repeated character, a straight run (123456…, abcdef…), or a short block repeated ("abcabcabcabc"). */
function isPattern(p: string): boolean {
  if (/^(.)\1+$/.test(p)) return true;
  const runs = (s: string, step: number) => { for (let i = 1; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== step) return false; return true; };
  if (/^[0-9]+$/.test(p) && (runs(p, 1) || runs(p, -1))) return true;
  if (/^[a-z]+$/.test(p) && (runs(p, 1) || runs(p, -1))) return true;
  for (let n = 1; n <= p.length / 2; n++) if (p.length % n === 0 && p.slice(0, n).repeat(p.length / n) === p) return true;
  return false;
}

export function isCommonPassword(plain: string): boolean {
  const p = plain.toLowerCase();
  return SET.has(p) || isPattern(p);
}
