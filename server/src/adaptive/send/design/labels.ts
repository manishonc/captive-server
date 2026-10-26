/**
 * The design's own words (button labels, the stub, the stars, the footer), in the wording's
 * language. Dates are written out ("Monday, 9 November") in the same language.
 */

import type { Lang } from '../../core/constants';

export interface DesignLabels {
  validUntil: string;
  showOffer: string;
  showGift: string;
  bookNow: string;
  openInfo: string;
  seeTips: string;
  rateLow: string;
  rateHigh: string;
  rateAria: (n: number) => string;
  checkInFrom: string;
  checkOutBy: string;
  checkOut: string;
  wifi: string;
  openingHours: string;
  address: string;
  whyMarketing: (venue: string) => string;
  whyService: (venue: string) => string;
  unsubscribe: string;
}

const EN: DesignLabels = {
  validUntil: 'Valid until',
  showOffer: 'Show my offer',
  showGift: 'Show my gift',
  bookNow: 'Book now',
  openInfo: 'Open guest info',
  seeTips: 'See our tips',
  rateLow: 'Not great',
  rateHigh: 'Loved it',
  rateAria: (n) => `${n} of 5 stars, opens the rating page`,
  checkInFrom: 'Check-in from',
  checkOutBy: 'Check-out by',
  checkOut: 'Check-out',
  wifi: 'Wi-Fi',
  openingHours: 'Opening hours',
  address: 'Address',
  whyMarketing: (v) => `You get this email because you said yes to news and offers from ${v}.`,
  whyService: (v) => `You get this email because you are a guest at ${v}.`,
  unsubscribe: 'Unsubscribe',
};

const DE: DesignLabels = {
  validUntil: 'Gültig bis',
  showOffer: 'Angebot zeigen',
  showGift: 'Geschenk zeigen',
  bookNow: 'Jetzt buchen',
  openInfo: 'Gästeinfos öffnen',
  seeTips: 'Unsere Tipps ansehen',
  rateLow: 'Nicht gut',
  rateHigh: 'Sehr gut',
  rateAria: (n) => `${n} von 5 Sternen, öffnet die Bewertungsseite`,
  checkInFrom: 'Check-in ab',
  checkOutBy: 'Check-out bis',
  checkOut: 'Check-out',
  wifi: 'WLAN',
  openingHours: 'Öffnungszeiten',
  address: 'Adresse',
  whyMarketing: (v) => `Du bekommst diese E-Mail, weil du Neuigkeiten und Angeboten von ${v} zugestimmt hast.`,
  whyService: (v) => `Du bekommst diese E-Mail als Gast von ${v}.`,
  unsubscribe: 'Abmelden',
};

const FR: DesignLabels = {
  validUntil: "Valable jusqu'au",
  showOffer: 'Voir mon offre',
  showGift: 'Voir mon cadeau',
  bookNow: 'Réserver',
  openInfo: 'Voir les infos',
  seeTips: 'Voir nos conseils',
  rateLow: 'Pas terrible',
  rateHigh: 'Excellent',
  rateAria: (n) => `${n} sur 5, ouvre la page d'avis`,
  checkInFrom: 'Arrivée dès',
  checkOutBy: 'Départ avant',
  checkOut: 'Départ',
  wifi: 'Wi-Fi',
  openingHours: "Heures d'ouverture",
  address: 'Adresse',
  whyMarketing: (v) => `Vous recevez cet e-mail car vous avez accepté les nouvelles et offres de ${v}.`,
  whyService: (v) => `Vous recevez cet e-mail en tant que client de ${v}.`,
  unsubscribe: 'Se désabonner',
};

const IT: DesignLabels = {
  validUntil: 'Valido fino a',
  showOffer: "Mostra l'offerta",
  showGift: 'Mostra il regalo',
  bookNow: 'Prenota ora',
  openInfo: 'Apri le info',
  seeTips: 'Scopri i consigli',
  rateLow: 'Non bene',
  rateHigh: 'Ottimo',
  rateAria: (n) => `${n} su 5, apre la pagina delle recensioni`,
  checkInFrom: 'Check-in dalle',
  checkOutBy: 'Check-out entro le',
  checkOut: 'Check-out',
  wifi: 'Wi-Fi',
  openingHours: 'Orari di apertura',
  address: 'Indirizzo',
  whyMarketing: (v) => `Ricevi questa e-mail perché hai accettato novità e offerte da ${v}.`,
  whyService: (v) => `Ricevi questa e-mail come ospite di ${v}.`,
  unsubscribe: 'Annulla iscrizione',
};

const ALL: Record<Lang, DesignLabels> = { en: EN, de: DE, fr: FR, it: IT };

export function labelsFor(lang: Lang): DesignLabels {
  return ALL[lang] ?? EN;
}

const LOCALES: Record<Lang, string> = { en: 'en-GB', de: 'de-CH', fr: 'fr-CH', it: 'it-CH' };

/**
 * "Monday 9 November" for a date the engine passes as noon UTC of the local day
 * (core/runtime/time.ts `localDateForRender`), so the UTC date is the local one.
 * Anything that isn't a date comes back as it was.
 */
export function longDate(iso: string | undefined, lang: Lang): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat(LOCALES[lang] ?? 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
  } catch {
    return iso.slice(0, 10);
  }
}
