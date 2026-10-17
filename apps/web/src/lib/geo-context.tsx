'use client';
import { createContext, useContext } from 'react';
import { DEFAULT_COUNTRY, COUNTRY_CONFIG, dialPrefix, phoneExampleFor, supportedCountry, type Currency } from '@surveyflow/shared';
import { useAccount } from './account';

export interface GeoValue { country: string; currency: Currency; detected: boolean }

const Ctx = createContext<GeoValue>({ country: DEFAULT_COUNTRY, currency: COUNTRY_CONFIG[DEFAULT_COUNTRY]!.currency, detected: false });

export const GeoProvider = Ctx.Provider;
/** The visitor's location, as resolved by the server for this request. */
export const useGeo = () => useContext(Ctx);

/**
 * The country that rules everything about the signed-in owner (phone prefix, example number, currency). It is the account's
 * country (which follows the visitor's location until the first payment, then stays), falling back to the visitor's location
 * while the account is still loading, then to Cameroon.
 */
export function useOwnerCountry(): { country: string; currency: Currency; dial: string; example: string } {
  const geo = useGeo();
  const { account } = useAccount();
  const country = supportedCountry(account?.user.country ?? geo.country);
  return { country, currency: COUNTRY_CONFIG[country]!.currency, dial: dialPrefix(country), example: phoneExampleFor(country) };
}
