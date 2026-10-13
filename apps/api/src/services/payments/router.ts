import { COUNTRY_CONFIG, PSP_CAPABILITIES, type PaymentMethod, type PspName } from '@surveyflow/shared';
import { CampayAdapter } from './adapters/campay';
import { CinetPayAdapter } from './adapters/cinetpay';
import { FlutterwaveAdapter } from './adapters/flutterwave';
import { MockPspAdapter } from './adapters/mock';
import { NotchPayAdapter } from './adapters/notchpay';
import { PayUnitAdapter } from './adapters/payunit';
import type { PSPAdapter } from './types';

/**
 * PSP router (spec §9.4). Differences from the spec's version:
 *  - it returns an ORDERED FAILOVER CHAIN, not one adapter: with a single choice, one PSP outage means no revenue for
 *    that country;
 *  - it only offers PSPs that are configured AND actually support the country / currency / method (the spec's
 *    `selectPSP` could return NotchPay for a Kenyan card even though it was never configured);
 *  - the spec's rules had redundant, unreachable branches (the XAF/XOF-card rule can never fire after the generic
 *    card rule); the table-driven COUNTRY_CONFIG replaces them.
 */
export class PSPRouter {
  private adapters = new Map<PspName, PSPAdapter>();

  constructor(adapters: PSPAdapter[] = [new CampayAdapter(), new NotchPayAdapter(), new PayUnitAdapter(), new CinetPayAdapter(), new FlutterwaveAdapter(), new MockPspAdapter()]) {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  getAdapter(name: string): PSPAdapter | undefined {
    return this.adapters.get(name as PspName);
  }

  chain(p: { country: string; currency: string; method: PaymentMethod; preferred?: string | null }): PSPAdapter[] {
    const mock = this.adapters.get('mock');
    // Demo mode: everything goes through the mock checkout.
    if (mock?.isConfigured()) return [mock];

    const cfg = COUNTRY_CONFIG[p.country];
    const wanted: PspName[] = !cfg
      ? ['flutterwave', 'notchpay']
      : p.method === 'card' ? cfg.cardPSPs
      : p.method === 'mobile_money' ? cfg.mobileMoneyPSPs
      : ['flutterwave', 'notchpay'];

    const usable = wanted.filter((name) => {
      const a = this.adapters.get(name);
      const cap = PSP_CAPABILITIES[name];
      return a && a.isConfigured() && (cap.countries === '*' || cap.countries.includes(p.country)) && cap.methods.includes(p.method) && (cap.currencies as string[]).includes(p.currency);
    });
    if (p.preferred && usable.includes(p.preferred as PspName)) usable.sort((a, b) => (a === p.preferred ? -1 : b === p.preferred ? 1 : 0));
    return usable.map((n) => this.adapters.get(n)!);
  }
}

export const pspRouter = new PSPRouter();
