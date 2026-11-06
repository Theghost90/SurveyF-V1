import type { Locale } from './i18n';

export interface TemplateQuestion { text: string; type: 'button' | 'list' | 'text' | 'rating' | 'multi'; required: boolean; options?: string[] }
export interface SurveyTemplate { id: string; title: string; description: string; questions: TemplateQuestion[] }

/** Starter surveys ("template gallery or from scratch", spec §5.1). Wording only — no invented statistics. */
export function surveyTemplates(locale: Locale): SurveyTemplate[] {
  const fr = locale === 'fr';
  return [
    {
      id: 'csat',
      title: fr ? 'Satisfaction client' : 'Customer satisfaction',
      description: fr ? '3 questions : satisfaction, recommandation, suggestions.' : '3 questions: satisfaction, recommendation, suggestions.',
      questions: [
        { text: fr ? 'Êtes-vous satisfait(e) de notre service ?' : 'How satisfied are you with our service?', type: 'button', required: true, options: fr ? ['Très satisfait', 'Neutre', 'Pas satisfait'] : ['Very satisfied', 'Neutral', 'Unsatisfied'] },
        { text: fr ? 'Recommanderiez-vous notre entreprise à un proche ?' : 'How likely are you to recommend us to a friend?', type: 'rating', required: true },
        { text: fr ? 'Avez-vous des suggestions pour nous améliorer ?' : 'Any suggestions for improvement?', type: 'text', required: false },
      ],
    },
    {
      id: 'delivery',
      title: fr ? 'Commande et livraison' : 'Order & delivery',
      description: fr ? 'Pour les commerces : délai, point à améliorer, remarque libre.' : 'For shops: delivery time, what to improve, free comment.',
      questions: [
        { text: fr ? 'Comment était le délai de livraison ?' : 'How was the delivery time?', type: 'button', required: true, options: fr ? ['Rapide', 'Correct', 'Trop long'] : ['Fast', 'OK', 'Too slow'] },
        { text: fr ? 'Que devrions-nous améliorer en premier ?' : 'What should we improve first?', type: 'list', required: true, options: fr ? ['Délai de livraison', 'Qualité du produit', 'Prix', 'Service client', 'Emballage', 'Autre'] : ['Delivery time', 'Product quality', 'Price', 'Customer service', 'Packaging', 'Other'] },
        { text: fr ? 'Un commentaire ?' : 'Anything else you would like to tell us?', type: 'text', required: false },
      ],
    },
    {
      id: 'event',
      title: fr ? 'Avis sur un événement' : 'Event feedback',
      description: fr ? 'Note globale, points appréciés, commentaire.' : 'Overall rating, what people liked, comment.',
      questions: [
        { text: fr ? 'Quelle note donnez-vous à l’événement ?' : 'How would you rate the event overall?', type: 'rating', required: true },
        { text: fr ? 'Qu’avez-vous préféré ?' : 'What did you like most?', type: 'multi', required: true, options: fr ? ['Les intervenants', 'Le lieu', 'La restauration', 'Les rencontres', 'Le programme'] : ['Speakers', 'Venue', 'Food', 'Networking', 'Schedule'] },
        { text: fr ? 'Un message pour les organisateurs ?' : 'A message for the organisers?', type: 'text', required: false },
      ],
    },
  ];
}
