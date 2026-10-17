import type { FastifyInstance } from 'fastify';
import { OVERAGE, currencyForCountry, identityQuote, overagePerBlock, planPrices, supportedCountry } from '@surveyflow/shared';
import { detectedCountry } from '../lib/geo';
import { quoteOrXaf } from '../services/fx';

/**
 * Public prices in the visitor's currency. The website's server asks on every pricing / home page view, passing the country it read from
 * the CDN header. Prices are the FCFA prices converted at the live rate (rounded to 3 significant digits); if no fresh rate exists the
 * answer is simply the FCFA prices, with `fallback: true`: an invented rate is never served.
 */
export default async function pricingRoutes(app: FastifyInstance) {
  app.get('/api/pricing', async (req) => {
    const country = supportedCountry(detectedCountry(req));
    const wanted = currencyForCountry(country);
    const { quote, fallback } = await quoteOrXaf(wanted);
    return {
      country,
      currency: quote.currency,
      requestedCurrency: wanted,
      fallback,
      quote: { rate: quote.rate, asOf: quote.asOf, source: quote.source },
      plans: planPrices(quote),
      plansFCFA: planPrices(identityQuote('XAF')),
      overagePer100: overagePerBlock(quote),
      overageBlock: OVERAGE.responsesBlockSize,
    };
  });
}
