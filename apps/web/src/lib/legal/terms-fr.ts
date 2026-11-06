import { ENTITY, LEGAL_VERSION, contactLine, longDate } from './shared';
import type { LegalContext, LegalDoc } from './types';

/**
 * Conditions d’utilisation, français. Les renvois (« art. 9 ») visent la loi n° 2024/017 du 23 décembre 2024 relative à la protection des données à
 * caractère personnel au Cameroun (copie certifiée conforme dans docs/legal/). Ce texte doit dire la même chose que terms-en.ts : un test les compare et
 * fixe les rangs vers lesquels renvoient les phrases (« section 5 » : les responsabilités du Client ; « section 14 » : le traitement des données).
 * Ce que la première version ne comprend pas (cadeaux, portefeuille, API, marque blanche) est dit à la section 2 à dessein : c’est le périmètre pour lequel
 * le texte a été écrit.
 */
export const termsFr = (ctx: LegalContext): LegalDoc => ({
  title: 'Conditions d’utilisation',
  description: 'Le contrat entre SurveyFlow et ses Clients : ce qu’est et n’est pas le service, ce dont chaque partie est responsable, la facturation, la responsabilité et le traitement des données des contacts.',
  meta: `Version du ${longDate(LEGAL_VERSION, 'fr')} · ${ENTITY.name}, ${ENTITY.place}`,
  tocLabel: 'Sur cette page',
  lead: `Ces Conditions sont le contrat entre ${ENTITY.name} et la personne ou l’organisation qui crée un compte SurveyFlow (le « Client », « vous »). Elles disent ce qu’est et n’est pas le service, ce dont chaque partie est responsable, et comment les données des contacts du Client sont traitées. Lisez avec attention les sections 2, 5 et 11.`,
  sections: [
    {
      id: 'parties',
      h: 'Qui nous sommes et comment vous acceptez',
      blocks: [
        { p: `Le service est fourni par **${ENTITY.name}**, ${ENTITY.place} (« SurveyFlow », « nous »).` },
        { p: 'En créant un compte ou en utilisant le service, vous acceptez ces Conditions et la [Politique de confidentialité](/privacy). Si vous ne les acceptez pas, n’utilisez pas le service. Si vous vous inscrivez pour une organisation, vous confirmez avoir le pouvoir de l’engager. Vous devez être majeur et juridiquement capable de contracter.' },
        { p: 'Les Conditions existent en français et en anglais. Les deux ont la même valeur.' },
      ],
    },
    {
      id: 'service',
      h: 'Ce qu’est SurveyFlow, et ce qu’il n’est pas',
      blocks: [
        { p: '**Ce que fait le service.** SurveyFlow est une application web qui vous permet de construire des sondages ; de les envoyer à vos propres contacts sur WhatsApp par la plateforme WhatsApp Business de Meta ; de laisser des personnes rejoindre un sondage par un lien ou un code QR ; de recevoir leurs réponses dans WhatsApp ; de voir les résultats et les analyses ; de les exporter (CSV, Excel, PDF, Google Sheets) ; d’inviter des membres d’équipe ; et de demander vos résultats au Bot Analytics de SurveyFlow sur WhatsApp. Les formules (Explore, Starter, Growth et Business), leurs limites et leurs prix figurent sur la page des tarifs.' },
        { p: '**Ce qui ne fait pas partie du service dans cette version :**' },
        {
          ul: [
            'Les cadeaux et récompenses pour les Participants, de toute nature (crédit téléphonique, données mobiles, transferts Mobile Money, codes de réduction, tirages au sort ou reçus), et tout portefeuille prépayé. SurveyFlow ne détient, ne transfère, ne convertit ni ne verse d’argent pour des Clients ou des Participants. Les seuls paiements sont ceux que vous faites à SurveyFlow pour votre formule ou pour une facture de dépassement.',
            'L’accès par API et l’usage en marque blanche.',
            'Les canaux de messagerie autres que WhatsApp, comme le SMS.',
            'La vérification du consentement : SurveyFlow ne vérifie pas que vos contacts ont accepté d’être contactés (section 5).',
            'Un conseil juridique, réglementaire ou d’éthique de la recherche ; des listes de contacts ; ou toute garantie que des personnes recevront, liront ou rempliront vos sondages.',
            'Tout ce que fournissent Meta, Google ou un prestataire de paiement. Ce sont des sociétés indépendantes (section 9). SurveyFlow n’est ni détenu par Meta ou WhatsApp, ni affilié à eux, ni approuvé par eux.',
          ],
        },
        { p: 'Si nous proposons plus tard des récompenses, un portefeuille ou d’autres fonctions qui font intervenir de l’argent, elles ne seront disponibles que selon des conditions supplémentaires que vous accepterez d’abord. D’ici là, rien dans l’application ni dans nos documents n’en constitue une offre.' },
      ],
    },
    {
      id: 'account',
      h: 'Votre compte',
      blocks: [
        {
          ul: [
            'Donnez des informations exactes, tenez-les à jour et confirmez votre adresse e-mail.',
            'Gardez secrets votre mot de passe et tout secret d’authentificateur ; nous recommandons la vérification en deux étapes. Vous êtes responsable de tout ce qui est fait par votre compte.',
            'Les membres d’équipe que vous invitez agissent sous votre responsabilité. Vous choisissez leur rôle (lecteur ou éditeur) et vous les retirez quand ils ne doivent plus avoir accès. Chaque action qu’ils font est enregistrée à leur nom.',
            'Prévenez-nous aussitôt si vous pensez que quelqu’un d’autre a utilisé votre compte.',
            'Vous pouvez fermer votre compte à tout moment dans les Paramètres. Il reste alors en lecture seule pendant 30 jours, pendant lesquels vous pouvez annuler ; ensuite le compte et ses données sont effacés, sauf les pièces comptables décrites dans la Politique de confidentialité. Nous pouvons différer la fermeture tant qu’un paiement que vous nous devez n’est pas réglé.',
          ],
        },
      ],
    },
    {
      id: 'meta',
      h: 'WhatsApp, Meta et coût des messages',
      blocks: [
        {
          ul: [
            'Il vous faut votre propre compte et numéro WhatsApp Business, connectés à SurveyFlow par le parcours d’inscription de Meta. Ne connectez qu’un numéro que vous contrôlez et que vous avez le droit d’utiliser.',
            'Vous devez suivre les conditions et politiques de Meta qui s’appliquent à votre usage, notamment les Conditions d’utilisation de WhatsApp Business, la Politique de messagerie de WhatsApp Business et les Conditions de la plateforme Meta. C’est Meta, et non SurveyFlow, qui décide si votre numéro peut envoyer des messages, de ses limites d’envoi et de sa note de qualité, et qui peut le restreindre ou le désactiver. SurveyFlow n’est pas responsable de ces décisions.',
            'Meta vous facture directement les messages envoyés par votre compte WhatsApp Business, à ses prix et selon ses catégories. SurveyFlow ne facture, n’encaisse, ne rembourse ni ne contrôle les frais de Meta. Gardez un moyen de paiement valide chez Meta ; sans lui, Meta peut cesser de remettre vos messages.',
            'SurveyFlow traite un sondage comme un message marketing, qui coûte plus cher, sauf si vous déclarez que les personnes le reçoivent à cause de quelque chose qu’elles ont fait avec votre entreprise et qu’il ne contient rien de promotionnel. Votre déclaration doit être vraie. Nous vous demandons d’accepter le coût avant chaque envoi marketing. Meta peut recatégoriser un message ; si elle le fait, nous vous le disons et l’envoi attend votre acceptation.',
            'Si votre numéro sert aussi dans l’application WhatsApp Business, les règles de Meta pour ce montage s’appliquent, y compris les limites de ce qui est repris. Les contacts que WhatsApp transmet à SurveyFlow sont conservés sans marque de consentement tant que vous n’avez pas confirmé que ces personnes ont accepté d’être contactées ; ne confirmez que ce qui est vrai (section 5). Si Meta met fin à la connexion, vos sondages sont suspendus jusqu’à ce que vous vous reconnectiez.',
          ],
        },
      ],
    },
    {
      id: 'duties',
      h: 'Vos responsabilités pour vos contacts et vos messages',
      blocks: [
        { p: 'SurveyFlow vous donne l’outil. **Vous décidez qui contacter, avec quoi et pourquoi, et vous en répondez.** En particulier :' },
        {
          ol: [
            '**Vous êtes le responsable du traitement.** Pour les données de vos contacts et des Participants, vous êtes le responsable du traitement au sens de la Loi. Vous êtes responsable de sa licéité : consentement (art. 9 et 50), information claire de la personne (art. 14 et 21), finalités (art. 11), exactitude (art. 12), conservation (art. 13), demandes des personnes sur leurs droits (art. 37 à 47), et toute déclaration ou autorisation que la Loi exige d’un responsable du traitement pour votre propre usage (art. 19 et 49). SurveyFlow est responsable de celles qui concernent son propre traitement et ses propres prestataires (section 14).',
            '**Consentement avant de contacter.** Avant d’ajouter ou d’importer un contact, cette personne doit avoir accepté au préalable, de façon explicite, libre et suffisamment informée, de recevoir des messages WhatsApp du type que vous envoyez (art. 5 et 9). Vous devez pouvoir démontrer cet accord si l’Autorité de protection des données personnelles, un tribunal, Meta ou SurveyFlow le demande. La case que vous cochez dans SurveyFlow est votre déclaration : SurveyFlow la conserve avec l’heure et l’origine et ne la vérifie pas. Si elle est inexacte, vous en supportez les conséquences.',
            '**Contacts de votre application WhatsApp Business.** Ne les confirmez que si ces personnes ont accepté de recevoir des sondages de votre part.',
            '**Liens d’adhésion et codes QR.** Vous choisissez où les partager et vous répondez de ce choix. Le premier message demande le consentement et dit comment arrêter ; ne le retirez pas et ne le cachez pas, et n’utilisez pas un lien pour collecter des numéros à une autre fin.',
            '**STOP.** Lorsqu’une personne répond STOP, ou s’oppose autrement, vous ne devez plus la contacter, ni par SurveyFlow ni par aucun autre moyen en utilisant les données obtenues grâce à lui (art. 40). SurveyFlow respecte STOP automatiquement ; n’essayez jamais de le contourner.',
            '**Pas de prospection directe.** N’utilisez pas SurveyFlow pour promouvoir des biens, des services ou votre image auprès de personnes qui n’y ont pas donné leur consentement préalable, et ne donnez ni ne vendez les données des Participants à des tiers à des fins de marketing (art. 41).',
            '**Données que vous ne devez pas collecter.** Ne collectez pas, par des questions ou autrement, de données relatives aux opinions ou activités religieuses, philosophiques, politiques ou syndicales, à l’origine raciale ou ethnique, à l’origine linguistique ou régionale, à la génétique ou à la biométrie de santé, ni de données liées à des opérations bancaires (art. 48) ; ni d’informations de santé, de numéros de pièces d’identité, de numéros de carte ou de mots de passe. Si de telles données arrivent dans une réponse en texte libre, supprimez-les. Nous pouvons les supprimer.',
            '**Personnes mineures.** Ne sondez personne de moins de dix-huit ans sans le consentement d’un parent ou d’un représentant légal (art. 9 et 18). SurveyFlow ne vérifie pas l’âge.',
            '**Pas de profilage.** N’utilisez pas SurveyFlow pour profiler des personnes, et n’utilisez pas les réponses pour prendre des décisions automatisées à leur sujet (art. 44 et 65).',
            '**Demandes des personnes.** Répondez, dans le délai légal, aux demandes de vos contacts de voir, corriger ou effacer leurs données, avec les outils de l’application. Dites-nous si vous avez besoin de notre aide.',
            '**Votre contenu.** Les questions, les messages et les résultats sont les vôtres et sous votre responsabilité. Ils doivent être licites, sincères sur l’identité de celui qui interroge, et respecter les lois et règles d’éthique applicables à votre activité (publicité, élections et sondages politiques, santé, éthique de la recherche) dans chaque pays où se trouvent vos contacts.',
            '**Violation.** Prévenez-nous sans délai si vous apprenez une violation de données qui concerne SurveyFlow, et remplissez votre propre devoir d’informer l’Autorité et les personnes concernées (art. 22).',
            '**Lois d’autres pays.** Si vos contacts sont dans un autre pays, la loi de protection des données de ce pays peut aussi s’appliquer à vous ; vous en êtes responsable.',
          ],
        },
      ],
    },
    {
      id: 'use',
      h: 'Utilisation acceptable',
      blocks: [
        { p: 'Vous ne devez pas : envoyer de spam ou de messages non sollicités ; envoyer un contenu illicite, trompeur, injurieux, haineux ou discriminatoire, ou qui porte atteinte aux droits d’autrui ; vous faire passer pour une autre personne ou organisation ; utiliser un sondage pour hameçonner, obtenir des mots de passe, des codes ou des données de paiement, ou commettre une fraude ; enfreindre les politiques de Meta ; chercher à contourner les limites, plafonds, étapes de consentement ou la sécurité (par exemple en ouvrant plusieurs comptes pour éviter une limite) ; sonder le service, en extraire automatiquement des données, le surcharger ou en faire la rétro-ingénierie ; revendre le service ou en donner l’accès à d’autres sans notre accord écrit ; ou téléverser du code malveillant.' },
        { p: 'Les comptes dont les messages sont signalés ou bloqués par beaucoup de personnes peuvent abaisser la note de qualité de la plateforme WhatsApp partagée. Nous pouvons les suspendre.' },
      ],
    },
    {
      id: 'billing',
      h: 'Formules, paiement et facturation',
      blocks: [
        {
          ul: [
            '**Formules.** Les formules, limites et prix figurent sur la page des tarifs. Les prix peuvent être affichés dans votre devise à un taux de change approximatif ; le montant qui vous est facturé est indiqué avant que vous payiez.',
            '**Paiement.** Les abonnements sont payés d’avance par des prestataires de paiement indépendants. Mobile Money ne se renouvelle pas automatiquement : pour renouveler, payez à nouveau. Nous ne conservons pas de numéros de carte. SurveyFlow n’est ni une banque, ni un établissement de paiement, ni un émetteur de monnaie électronique, et il ne détient ni ne verse l’argent d’autrui.',
            '**Passage à une formule supérieure.** Si vous passez à une formule plus grande avant la fin de celle que vous avez payée, les jours entiers non utilisés de ce que vous avez payé sont déduits du nouveau prix, qui ne descend jamais sous 10 pour cent du prix de la nouvelle formule. Passer à une formule inférieure se fait en laissant la formule en cours se terminer.',
            '**Réponses au-delà de votre formule.** Une réponse n’est jamais refusée. Si vous l’acceptez dans Facturation, les réponses au-delà de votre quota mensuel sont facturées après chaque mois à 500 FCFA par tranche de 100 réponses ; vous payez la facture vous-même et rien n’est prélevé automatiquement. Si une facture reste impayée après son échéance, nous pouvons cesser d’envoyer de nouveaux messages pour votre compte, et refuser les renouvellements et les changements de formule, jusqu’à son paiement. Nous ne supprimons pas vos données pour le seul défaut de paiement.',
            '**Pas de remboursement** des sommes déjà payées, sauf la déduction ci-dessus et lorsque la loi impérative vous donne un droit.',
            '**Taxes.** Vous êtes responsable des taxes applicables à votre usage. Si nous devons percevoir une taxe, nous l’indiquons avant que vous payiez.',
            '**Les frais de Meta** sont distincts et sont payés à Meta (section 4).',
            '**Changements de prix.** Nous vous prévenons au moins 30 jours avant qu’un nouveau prix s’applique ; il s’applique à partir de votre prochain paiement.',
          ],
        },
      ],
    },
    {
      id: 'content',
      h: 'Contenu et propriété intellectuelle',
      blocks: [
        { p: `SurveyFlow, son logiciel, son design et sa marque appartiennent à ${ENTITY.name} ou à ses concédants. Nous vous accordons un droit limité, non exclusif et non transférable d’utiliser le service tant que votre compte est ouvert. Entre vous et nous, vos sondages, les données de vos contacts et les réponses restent à vous (ou aux personnes qui les ont données). Vous nous autorisez à les héberger, les traiter et les transmettre dans la mesure nécessaire pour fournir le service et comme le disent ces Conditions. Nous pouvons utiliser des comptages et des mesures qui ne contiennent ni contenu de sondage ni identité personnelle pour faire fonctionner et améliorer le service. Si vous nous envoyez des retours, nous pouvons les utiliser librement.` },
      ],
    },
    {
      id: 'responsibilities',
      h: 'Qui est responsable de quoi',
      blocks: [
        {
          rows: [
            [ENTITY.name, 'Fait fonctionner et sécurise la plateforme ; traite les données des Participants uniquement pour vous et sur vos instructions ; est le responsable du traitement des données de compte, de facturation et de sécurité ; choisit ses prestataires avec des garanties suffisantes ; vous assiste à son contact publié ; et respecte la Loi pour son propre rôle (art. 16, 20 et 26).'],
            ['Vous, le Client', 'Vos contacts, leur consentement, vos messages et vos questions, votre usage des résultats, votre équipe, votre conformité à la Loi et aux règles de Meta, vos frais chez Meta et vos taxes (sections 3 à 7).'],
            ['Les membres de votre équipe', 'Ils agissent sous votre compte et votre responsabilité.'],
            ['Participants', 'Ils sont libres de refuser, d’arrêter avec STOP et de demander leurs droits. Leur consentement est recueilli par vous.'],
            ['Meta (WhatsApp)', 'Fournit WhatsApp ; fixe ses règles, ses prix, ses limites et ses catégories de messages ; et décide du sort de votre numéro. Elle est indépendante de SurveyFlow.'],
            ['Prestataires de paiement', 'Traitent les paiements selon leurs propres conditions. Ils ne sont pas des mandataires de SurveyFlow, et leurs retards ou défaillances sont les leurs.'],
            ['Google', 'Uniquement si vous utilisez la connexion Google ou Google Sheets : c’est votre relation avec Google.'],
            ['Prestataires d’hébergement, d’e-mail, de CAPTCHA et de vérification des mots de passe', 'Traitent des données pour SurveyFlow sur ses instructions. SurveyFlow les choisit et vous répond de ce choix (section 14).'],
          ],
        },
      ],
    },
    {
      id: 'availability',
      h: 'Disponibilité et support',
      blocks: [
        { p: 'Nous nous efforçons de maintenir le service en marche, mais nous ne promettons ni un service ininterrompu ou sans erreur, ni un délai de réponse, ni un niveau de disponibilité. Le service dépend de Meta, des prestataires de paiement, de l’hébergement et des réseaux que nous ne contrôlons pas. La remise, la rapidité et les taux de réponse des messages WhatsApp ne sont pas garantis. Nous pouvons faire de la maintenance et modifier ou retirer des fonctions, et nous vous prévenons à l’avance quand nous le pouvons. Le support est assuré par e-mail à l’adresse de contact publiée sur ce site, au mieux de nos moyens, sans délai de réponse promis. Dans la mesure où la loi le permet, le service est fourni « en l’état » et « selon disponibilité ».' },
      ],
    },
    {
      id: 'liability',
      h: 'Limites de responsabilité',
      blocks: [
        {
          ul: [
            'Dans la mesure où la loi le permet, SurveyFlow n’est pas responsable des dommages indirects ou consécutifs, ni de la perte de bénéfice, de chiffre d’affaires, de clientèle ou de données au-delà de ce que nos sauvegardes permettent de restaurer, ni des pertes qui résultent : de vos contacts, de votre consentement, de votre contenu ou de votre usage du service ; des décisions de Meta sur votre numéro, vos limites, vos catégories, vos prix ou vos frais ; de la défaillance ou du retard de Meta, d’un prestataire de paiement, d’un hébergeur ou d’un réseau ; d’un accès non autorisé causé par votre manque de soin, ou celui de votre équipe, avec les identifiants ; ou d’événements hors de notre contrôle.',
            'Notre responsabilité totale envers vous pour toutes les réclamations liées au service est limitée aux sommes que vous avez payées à SurveyFlow dans les 12 mois précédant l’événement qui a donné lieu à la réclamation.',
            'Rien dans ces Conditions n’exclut ni ne limite la responsabilité en cas de fraude, de faute lourde ou de faute intentionnelle, ni aucune responsabilité que la loi ne permet pas d’exclure ou de limiter.',
            'La Loi donne aux personnes dont les données sont traitées des droits contre le responsable du traitement comme contre le sous-traitant, y compris la responsabilité solidaire pour la divulgation de données personnelles sans leur consentement (art. 23). Ces Conditions ne limitent pas ces droits. Entre vous et nous, le partage des sections 5, 9, 12 et 14 s’applique.',
          ],
        },
      ],
    },
    {
      id: 'indemnity',
      h: 'Votre garantie',
      blocks: [
        { p: 'Vous indemniserez et défendrez SurveyFlow, ses associés, dirigeants et personnels contre les réclamations, amendes, sanctions, dommages et frais (y compris des honoraires juridiques raisonnables) engagés par un tiers, une personne concernée, Meta ou une autorité et découlant de vos contacts ou de l’absence de leur consentement, de votre contenu, de votre violation de la Loi, des politiques de Meta ou de ces Conditions, ou des actes des membres de votre équipe. Nous vous informerons rapidement d’une telle réclamation et coopérerons raisonnablement à vos frais. Vous ne pouvez pas transiger sur une réclamation d’une manière qui nous engage sans notre accord écrit.' },
      ],
    },
    {
      id: 'suspension',
      h: 'Suspension et résiliation',
      blocks: [
        { p: 'Nous pouvons suspendre ou mettre fin à votre accès, immédiatement si nécessaire, si vous enfreignez ces Conditions ou les politiques de Meta, si votre usage met en danger la plateforme, d’autres Clients ou des Participants, si la loi ou une autorité l’exige, ou si vous ne payez pas ce que vous devez. Nous vous disons pourquoi et, lorsque c’est possible, vous donnons la possibilité de corriger, sauf si cela serait dangereux ou illicite. Vous pouvez fermer votre compte à tout moment (section 3). À la fermeture ou à la résiliation, vos données sont traitées comme le dit la Politique de confidentialité. Les sections qui, par nature, doivent continuer (notamment 5, 11, 12 et 15, et 14 tant que nous conservons les données) continuent.' },
      ],
    },
    {
      id: 'data-processing',
      h: 'Conditions de traitement des données',
      blocks: [
        { p: 'Cette section est le contrat entre vous, responsable du traitement, et SurveyFlow, sous-traitant, que l’article 30 de la Loi exige pour les données de vos contacts et des Participants.' },
        {
          rows: [
            ['Objet et finalité', 'Hébergement, envoi par WhatsApp, collecte et conservation des réponses, production des résultats, exports et analyses, et conservation de la preuve du consentement et de la liste STOP, pour les sondages que vous menez.'],
            ['Durée', 'Tant que votre compte est ouvert, plus la période de lecture seule de 30 jours après votre demande de fermeture ; puis effacement comme le dit la Politique de confidentialité.'],
            ['Types de données', 'Noms (facultatifs), numéros WhatsApp, étiquettes, la marque de consentement avec son heure et son origine, l’indicateur STOP, les réponses (y compris le texte libre que vous demandez), l’état des messages, et les données de contact que WhatsApp transmet depuis votre application WhatsApp Business.'],
            ['Personnes concernées', 'Vos contacts et les personnes qui rejoignent vos sondages par lien ou code QR. Pour leurs propres comptes, les membres de votre équipe.'],
            ['Nos obligations', '(a) Traiter les données uniquement sur vos instructions documentées, qui sont ces Conditions et votre usage des réglages de l’application (art. 24). (b) Les garder confidentielles, et veiller à ce que toute personne que nous autorisons à les traiter soit tenue à la confidentialité et n’agisse que sur ces instructions (art. 24 et 25). (c) Appliquer les mesures de sécurité décrites dans la Politique de confidentialité (art. 22 et 25 à 27). (d) N’employer que les sous-traitants ultérieurs listés à la section 6 de la Politique de confidentialité, soumis à des obligations de même nature, et mettre cette liste à jour lorsqu’elle change ; si vous vous opposez à un nouveau, vous pouvez fermer votre compte. (e) Vous aider à répondre aux demandes des personnes sur leurs droits, par les outils de l’application et, au-delà, sur demande raisonnable. (f) Vous informer sans retard injustifié d’une violation qui affecte vos données (art. 22). (g) À la fermeture, vous laisser télécharger vos données puis les effacer comme décrit. (h) Vous donner les informations nécessaires pour démontrer notre conformité, sur demande raisonnable et au plus une fois par an, sauf après une violation.'],
            ['Vos obligations', 'Donner des instructions licites ; informer les personnes concernées comme l’exige la Loi (art. 21) ; recueillir et confirmer leur consentement ; répondre à leurs demandes ; ne pas nous demander de traiter des données qui ne peuvent pas l’être (section 5).'],
            ['Transferts hors du pays', 'Vous acceptez les transferts décrits à la section 7 de la Politique de confidentialité. SurveyFlow répond des autorisations et conditions que la Loi exige de lui pour ces transferts (art. 32).'],
            ['Nos propres données', 'Pour les données de compte, de facturation et de sécurité du Client, et pour les finalités limitées de la section 1 de la Politique de confidentialité, SurveyFlow agit en tant que responsable du traitement.'],
          ],
        },
      ],
    },
    {
      id: 'law',
      h: 'Droit applicable et litiges',
      blocks: [
        { p: 'Ces Conditions sont régies par le droit camerounais. En cas de litige, écrivez à l’autre partie à l’adresse de contact et essayez de bonne foi de le régler dans un délai de 30 jours. À défaut, les tribunaux compétents de Douala sont compétents, sous réserve de toute règle impérative qui vous donne le droit de saisir une autre juridiction.' },
      ],
    },
    {
      id: 'changes',
      h: 'Modifications de ces Conditions',
      blocks: [
        { p: 'Nous pouvons modifier ces Conditions. Pour une modification significative, nous vous prévenons par e-mail ou dans l’application au moins 30 jours avant qu’elle s’applique, sauf si Meta, la loi ou la sécurité exige un préavis plus court. Si vous continuez à utiliser le service après cette date, vous acceptez la modification. Si vous ne l’acceptez pas, fermez votre compte avant cette date.' },
      ],
    },
    {
      id: 'general',
      h: 'Dispositions générales',
      blocks: [
        { p: 'Ces Conditions, la Politique de confidentialité, la page des tarifs et tout ce que vous acceptez dans l’application (comme le coût d’un envoi) forment l’intégralité de l’accord entre nous sur le service. Si une partie ne peut pas être appliquée, le reste continue. Ne pas exercer un droit n’est pas y renoncer. Vous ne pouvez pas céder vos droits sans notre accord ; nous pouvons céder les nôtres à un successeur de l’activité. Aucune des parties n’est responsable d’une défaillance causée par des événements hors de son contrôle raisonnable, notamment des pannes ou décisions de Meta, de prestataires de paiement, de réseaux ou de fournisseurs d’électricité, et des actes d’autorités. Les notifications qui vous sont destinées vont à l’adresse e-mail de votre compte ; celles qui nous sont destinées vont au contact ci-dessous.' },
      ],
    },
    {
      id: 'contact',
      h: 'Contact',
      blocks: [{ p: contactLine('fr', ctx) }],
    },
  ],
});
