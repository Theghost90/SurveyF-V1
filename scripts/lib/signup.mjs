/**
 * Sign-up now ends with an e-mail link, not a session. These scripts run against an instance whose API uses the mock e-mail provider, whose mailbox the
 * "check your e-mail" page shows, so the whole path (form, link, confirmation, first sign-in) is driven through the real screens.
 * Call it right after pressing the register form's submit button. Ends on the page the sign-up leads to (onboarding), signed in.
 */
export async function confirmAndSignIn(page, base, { email, password = 'a-long-test-password' }) {
  await page.waitForURL('**/check-email**', { timeout: 30000 });
  const link = page.getByTestId('demo-link');
  await link.waitFor({ timeout: 20000 });
  await link.click();
  await page.waitForURL('**/verify-email**', { timeout: 15000 });
  await page.getByTestId('confirm-email').click();
  await page.getByRole('link', { name: /^sign in$/i }).waitFor({ timeout: 15000 });
  await page.getByRole('link', { name: /^sign in$/i }).click();
  await page.waitForURL('**/login**', { timeout: 15000 });
  await page.fill('#email', email);
  await page.fill('#password', password);
  await page.click('button[type=submit]');
  await page.waitForURL('**/onboarding**', { timeout: 30000 });
}
