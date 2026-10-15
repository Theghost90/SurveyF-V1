import { CARD_PSPS, COUNTRY_CONFIG, PSP_CAPABILITIES, rankByFee, type Currency, type PaymentMethod, type PspFees, type PspName } from '@surveyflow/shared';
import { env } from '../../config/env';
import { CamerPayAdapter } from './adapters/camerpay';
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

  constructor(adapters: PSPAdapter[] = [new CampayAdapter(), new NotchPayAdapter(), new CamerPayAdapter(), new PayUnitAdapter(), new CinetPayAdapter(), new FlutterwaveAdapter(), new MockPspAdapter()]) {
    for (const a of adapters) this.adapters.set(a.name, a);
  }

  getAdapter(name: string): PSPAdapter | undefined {
    return this.adapters.get(name as PspName);
  }

  /**
   * Silent provider choice: the owner never picks a PSP. Among providers that are configured and support this country /
   * currency / method, the cheapest for THIS payment comes first (percentage + fixed part, on `amountXAF` when known) and the
   * rest remain as failover. Cards are not tied to the buyer's country (a foreign card pays a Cameroonian merchant); mobile
   * money is local to the buyer's country.
   */
  chain(
    p: { country: string; currency: string; method: PaymentMethod; amountXAF?: number },
    fees: PspFees = env.pspFees,
    fixedToXAF?: (amount: number, currency: Currency) => number | null,
  ): PSPAdapter[] {
    const mock = this.adapters.get('mock');
    // Demo mode: everything goes through the mock checkout.
    if (mock?.isConfigured()) return [mock];

    const cfg = COUNTRY_CONFIG[p.country];
    const wanted: PspName[] = p.method === 'card' ? CARD_PSPS
      : !cfg ? ['flutterwave', 'notchpay']
      : p.method === 'mobile_money' ? cfg.mobileMoneyPSPs
      : ['flutterwave', 'notchpay'];

    const usable = wanted.filter((name) => {
      const a = this.adapters.get(name);
      const cap = PSP_CAPABILITIES[name];
      const countryOk = p.method === 'card' || cap.countries === '*' || cap.countries.includes(p.country);
      return a && a.isConfigured() && countryOk && cap.methods.includes(p.method) && (cap.currencies as string[]).includes(p.currency);
    });
    return rankByFee(usable, p.method, fees, { amountXAF: p.amountXAF, fixedToXAF }).map((n) => this.adapters.get(n)!);
  }
}

export const pspRouter = new PSPRouter();
