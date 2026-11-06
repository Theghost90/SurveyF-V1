/**
 * Walks the simulated Embedded Signup popup (demo mode) the way a customer would, for the browser scripts that only need a connected number.
 * `app: true` types a number that the simulated Meta says is in a WhatsApp Business app (ends in 2), otherwise a new one (ends in 1).
 * The caller must already be on the Connect step with the question answered. Ends with the popup closed.
 */
export async function connectSimulated(page, { app = false, paid = true, phone } = {}) {
  const number = phone ?? `+237 699 ${String(Date.now()).slice(-6)}${app ? '2' : '1'}`;
  await page.getByTestId('sim-open').click();
  await page.getByTestId('sim-login-btn').click();
  await page.getByTestId('sim-auth-btn').click();
  await page.getByTestId('sim-phone').fill(number);
  await page.getByTestId('sim-phone-next').click();
  if (app) {
    await page.getByTestId('sim-profile-btn').click();
    await page.getByTestId('sim-biz-next').click();
    await page.getByTestId('sim-qr-btn').click();
    await page.getByTestId('sim-tz-terms').click();
    await page.getByTestId('sim-tz-next').click();
  } else {
    await page.getByTestId('sim-code').fill('482913');
    await page.getByTestId('sim-verify-btn').click();
    await page.getByTestId('sim-biz-next').click();
    await page.getByTestId('sim-perm-btn').click();
  }
  await page.getByTestId('sim-done-btn').click();
  await page.getByTestId('sim-work-continue').click({ timeout: 30000 });
  await page.getByTestId(paid ? 'sim-bill-add' : 'sim-bill-later').click();
  await page.getByTestId('sim-bill-close').click();
  return number;
}
