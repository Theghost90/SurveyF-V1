/**
 * Facebook's JavaScript SDK checks the callback it is given with `Object.prototype.toString` and REFUSES an `async` function with
 * "Expression is of type asyncfunction, not function". Our handler waits for Meta's popup message, so it is async: this hands the SDK a plain function that starts it.
 * (Found on the first real run of the popup, 6 November 2026: demo mode never loads the real SDK, so no test could have shown it.)
 */
export interface FbSdk { login: (callback: (response: any) => void, options: Record<string, unknown>) => void }

export function fbLogin(fb: FbSdk, options: Record<string, unknown>, onResponse: (response: any) => Promise<void> | void): void {
  fb.login((response) => { void Promise.resolve(onResponse(response)).catch(() => undefined); }, options);
}
