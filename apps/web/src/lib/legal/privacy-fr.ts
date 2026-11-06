import { ENTITY, LEGAL_VERSION, contactLine, longDate } from './shared';
import type { LegalContext, LegalDoc } from './types';

/**
 * Politique de confidentialité, français. Les renvois à la loi (« art. 9 ») visent la loi n° 2024/017 du 23 décembre 2024 relative à la protection des
 * données à caractère personnel au Cameroun ; les numéros sont ceux de la copie certifiée conforme conservée dans docs/legal/ (même numérotation
 * dans les textes anglais et français, art. 75). Ce texte doit dire la même chose que privacy-en.ts : un test les compare (mêmes sections, mêmes blocs,
 * mêmes renvois). Les sections sont numérotées par leur rang et certaines phrases renvoient à un numéro (« section 6 ») : le test fixe ces rangs.
 */
export const privacyFr = (ctx: LegalContext): LegalDoc => ({
  title: 'Politique de confidentialité',
  description: 'Les données personnelles que SurveyFlow traite, qui en est responsable, qui les reçoit, combien de temps elles sont conservées et les droits des personnes selon la loi n° 2024/017.',
  meta: `Version du ${longDate(LEGAL_VERSION, 'fr')} · ${ENTITY.name}, ${ENTITY.place}`,
  tocLabel: 'Sur cette page',
  lead: 'SurveyFlow est un outil que des entreprises, des institutions et des chercheurs (nos « Clients ») utilisent pour envoyer des sondages sur WhatsApp à leurs propres contacts. Cette politique explique quelles données personnelles sont traitées, pourquoi, qui en est responsable, qui les reçoit et quels droits ont les personnes. Deux groupes de personnes sont concernés : les Clients et leurs équipes, et les personnes qui reçoivent ou remplissent un sondage (les « Participants »). Si vous avez reçu un sondage sur WhatsApp, lisez la section 2.',
  sections: [
    {
      id: 'who',
      h: 'Qui nous sommes et qui est responsable de quoi',
      blocks: [
        { p: `Le service est exploité par **${ENTITY.name}**, ${ENTITY.place} (« SurveyFlow », « nous »). La loi qui s’applique d’abord à nous est la loi n° 2024/017 du 23 décembre 2024 relative à la protection des données à caractère personnel au Cameroun (la « Loi »). La section 12 dit ce qui s’applique dans les autres pays.` },
        {
          rows: [
            ['Clients et membres de leur équipe', 'SurveyFlow est le **responsable du traitement** des données du compte du Client : inscription, facturation, sécurité, et utilisation du site et de l’application.'],
            ['Participants', 'Le **Client est le responsable du traitement** : il décide qui il contacte, ce qu’il demande et pourquoi, et il détient le consentement des Participants. SurveyFlow est le **sous-traitant** : il conserve et transmet les données pour le Client et sur ses instructions, selon les conditions de traitement des données de la section 14 des Conditions d’utilisation.'],
            ['Exceptions limitées', 'SurveyFlow conserve aussi certaines données de Participants pour ses propres finalités lorsque la Loi ou la sécurité l’exige : respecter une demande STOP, prévenir les abus et la fraude, et tenir les registres que nous sommes tenus de tenir. Pour ces finalités, SurveyFlow répond de l’usage qu’il en fait.'],
            ['Prestataires', 'Meta (WhatsApp), les prestataires de paiement et les autres sociétés de la section 6 reçoivent des données pour accomplir leur part du service. Ils ne deviennent pas propriétaires des données du Client, et chacun répond, selon ses propres conditions, de son propre usage.'],
          ],
        },
        { p: 'Selon la Loi, un responsable du traitement et un sous-traitant sont tenus des mêmes obligations (art. 20), et un sous-traitant doit présenter des garanties suffisantes de sécurité et de conformité (art. 16 et 26). Le partage ci-dessus dit qui répond devant qui ; il ne diminue les devoirs de personne.' },
      ],
    },
    {
      id: 'participants',
      h: 'Si vous avez reçu un sondage sur WhatsApp (information des Participants)',
      blocks: [
        { p: 'Une entreprise ou une organisation (l’« expéditeur ») a utilisé SurveyFlow pour vous envoyer un sondage, ou vous l’avez lancé vous-même en ouvrant le lien ou le code QR de l’expéditeur et en répondant START.' },
        {
          rows: [
            ['Qui est responsable de vos données', `L’expéditeur décide de vous contacter et de ce qu’il demande : il est le responsable du traitement. ${ENTITY.name}, ${ENTITY.place}, fournit le logiciel et conserve les données pour l’expéditeur, en tant que son sous-traitant.`],
            ['Ce qui est conservé', 'Votre numéro WhatsApp ; votre nom, si l’expéditeur l’a indiqué ou si vous l’avez donné ; les étiquettes ajoutées par l’expéditeur ; si vous avez accepté d’être contacté, quand et comment (la déclaration de l’expéditeur, un lien d’adhésion, ou le mot START) ; si vous avez répondu STOP ; vos réponses ; et si les messages ont été remis et lus.'],
            ['Pourquoi', 'Pour vous envoyer le sondage, recueillir vos réponses et permettre à l’expéditeur d’en lire les résultats. SurveyFlow ne vend pas vos données, ne les utilise pas pour la publicité et n’établit pas de profil vous concernant.'],
            ['Qui les voit', 'L’expéditeur et les collègues auxquels il a donné accès. Meta achemine les messages WhatsApp. Les prestataires de SurveyFlow conservent les données pour notre compte (section 6). Vos réponses ne sont jamais montrées aux autres Clients de SurveyFlow.'],
            ['Pendant combien de temps', 'Jusqu’à ce que l’expéditeur les supprime ou ferme son compte ; elles sont alors effacées de SurveyFlow (section 8).'],
            ['Hors du Cameroun', 'WhatsApp et certains de nos prestataires sont situés hors du Cameroun (section 7).'],
            ['Vos choix', 'Répondez **STOP** à tout moment et cet expéditeur ne vous contactera plus. Vous pouvez demander à l’expéditeur, ou à nous, de vous laisser voir, corriger ou effacer vos données, ou vous opposer à leur utilisation (section 9). Vous pouvez saisir l’Autorité de protection des données personnelles.'],
          ],
        },
      ],
    },
    {
      id: 'customers',
      h: 'Ce que nous conservons sur les Clients et leur équipe',
      blocks: [
        {
          ul: [
            '**Compte :** nom, nom de l’entreprise ou de l’organisation, adresse e-mail, numéro de téléphone, pays, langue, type de client (entreprise, institution ou universitaire) et formule.',
            '**Connexion :** votre mot de passe n’est conservé que sous forme d’une empreinte à sens unique et ne peut jamais être lu. Si vous vous connectez avec Google, nous recevons votre identifiant Google, votre nom et votre adresse e-mail. Si vous activez la vérification en deux étapes, le secret de l’authentificateur est conservé chiffré.',
            '**Paiements :** le prestataire utilisé, le montant, l’état, la référence, et le numéro Mobile Money ou les informations du payeur que le prestataire renvoie. Nous ne recevons ni ne conservons de numéros de carte : la carte est saisie sur la page du prestataire.',
            '**Comptes connectés :** le numéro WhatsApp et les identifiants du compte WhatsApp Business, et les jetons d’accès à WhatsApp et, si vous connectez Google Sheets, à Google, conservés chiffrés. Le numéro que vous liez au Bot Analytics de SurveyFlow et les commandes que vous lui envoyez.',
            '**Journaux de sécurité :** connexions et événements de sécurité (un libellé du navigateur, les trois premiers groupes de l’adresse IP, le pays), et un journal des actions sensibles de vous et des membres de votre équipe (exports, suppressions, ajout d’un membre). Nous l’utilisons pour protéger votre compte et pour montrer qui a fait quoi.',
            '**Votre contenu :** sondages, modèles et réglages, l’équipe que vous invitez (nom, adresse e-mail et rôle), et les messages que vous nous envoyez pour du support.',
            '**Cookies :** un cookie de session qui vous garde connecté et un cookie de langue. Cloudflare Turnstile (un CAPTCHA) s’exécute à l’inscription et après des connexions échouées et peut utiliser ses propres données techniques. Nous n’utilisons aucun cookie publicitaire ni de suivi.',
          ],
        },
      ],
    },
    {
      id: 'participant-data',
      h: 'Ce que nous conservons sur les Participants, pour le Client',
      blocks: [
        {
          ul: [
            '**Ce que fournit le Client :** un nom (facultatif), un numéro WhatsApp, des étiquettes, et si la personne a accepté d’être contactée, avec l’heure et l’origine (saisie par le Client, fichier importé, lien d’adhésion ou START).',
            '**Ce qu’envoie le Participant :** des réponses (choix, notes, texte libre), des réponses comme STOP, et sa progression dans le sondage.',
            '**État des messages :** envoyé, remis, lu, échoué.',
            '**Contacts de l’application WhatsApp Business du Client :** si le Client connecte un numéro qui sert aussi dans l’application WhatsApp Business, WhatsApp peut nous transmettre le carnet d’adresses (noms et numéros). Nous les conservons sans marque de consentement tant que le Client n’a pas confirmé que ces personnes ont accepté d’être contactées. L’historique des conversations et les messages que le Client a écrits dans l’application sont comptés mais jamais lus ni conservés.',
            'Les noms et les numéros sont chiffrés dans la base de données et masqués à l’écran. Les réponses sont conservées sans chiffrement au niveau du champ et protégées comme le décrit la section 10.',
          ],
        },
        { p: 'SurveyFlow ne lit pas les réponses des Participants pour ses propres besoins, ne les regroupe pas entre Clients, ne les vend pas, et ne prend aucune décision concernant une personne par des moyens automatisés. Les données de chaque Client sont séparées de celles de tous les autres. SurveyFlow n’a pas d’écran pour lire les réponses des Participants ; l’accès technique à la base de données est limité à l’opérateur qui fait fonctionner, sécurise et répare le service.' },
        { p: '**Ce qui ne doit pas être collecté.** La Loi interdit le traitement des données relatives aux opinions et activités religieuses, philosophiques, politiques ou syndicales, à l’origine raciale ou ethnique, à l’origine linguistique ou régionale, à la génétique et à la biométrie de santé, ainsi que le traitement lié aux opérations bancaires sans l’autorisation des autorités compétentes (art. 48). Les Conditions interdisent aux Clients d’utiliser SurveyFlow pour cela, ou pour des informations de santé, et nous pouvons supprimer de tels contenus.' },
      ],
    },
    {
      id: 'why',
      h: 'Pourquoi nous utilisons les données, et sur quelle base',
      blocks: [
        {
          ul: [
            'Pour fournir le service demandé : créer et envoyer des sondages, recueillir des réponses, afficher résultats et exports, et faire fonctionner le Bot Analytics.',
            'Pour encaisser les paiements et tenir les écritures comptables.',
            'Pour protéger les comptes et la plateforme : contrôles de connexion, limites de débit, prévention des abus et de la fraude, et tenue de la liste STOP.',
            'Pour communiquer avec vous : confirmations, alertes de sécurité, avis de facturation et de renouvellement, et un avis lorsque WhatsApp déconnecte votre numéro.',
            'Pour respecter des obligations légales.',
            'Pour améliorer le service, à partir de comptages et de mesures qui ne contiennent ni contenu de sondage ni identités.',
          ],
        },
        { p: '**Base.** La Loi exige le consentement préalable, libre, éclairé, spécifique et non équivoque de la personne concernée (art. 9 et 50), avec des exceptions limitées comme une obligation légale (art. 9). Les Clients donnent leur consentement en créant un compte et en acceptant les Conditions d’utilisation et cette politique, et peuvent le retirer en fermant le compte (art. 38). Le consentement des Participants est recueilli par le Client, qui en répond (section 5 des Conditions d’utilisation). Pour les personnes qui rejoignent par lien ou code QR, le premier message demande le consentement et rien d’autre ne se passe tant que la personne n’a pas répondu START.' },
      ],
    },
    {
      id: 'recipients',
      h: 'Qui reçoit les données',
      blocks: [
        {
          rows: [
            ['Meta (WhatsApp)', 'Les numéros des Participants, le texte des messages et des réponses, l’état de remise, et les informations professionnelles WhatsApp du Client. Meta les traite selon ses propres conditions et politiques.'],
            ['Prestataires de paiement (tels que Notch Pay, CinetPay, Campay, PayUnit, Flutterwave et CamerPay ; celui qui est utilisé dépend de votre pays et de votre mode de paiement)', 'Ce qui est nécessaire pour encaisser l’abonnement : montant, référence, et le nom ou le numéro Mobile Money que le prestataire demande. Ils ne sont pas nos employés et agissent selon leurs propres conditions.'],
            ['Google', 'Uniquement si le Client se connecte avec Google ou connecte Google Sheets : les identifiants de connexion et, pour Sheets, les résultats que le Client nous demande d’écrire dans son propre compte Google.'],
            ['Cloudflare (Turnstile)', 'Les signaux techniques nécessaires pour distinguer les personnes des programmes automatiques à l’inscription et après des connexions échouées.'],
            ['Vérification des mots de passe (haveibeenpwned.com)', 'Les cinq premiers caractères d’une empreinte à sens unique d’un nouveau mot de passe, pour refuser les mots de passe connus par des fuites. Rien d’autre, et jamais le mot de passe.'],
            ['Prestataire d’e-mail', 'L’adresse e-mail du Client et le contenu des e-mails que nous envoyons (confirmation, sécurité, facturation, avis).'],
            ['Prestataire d’hébergement et de base de données', 'Toutes les données que nous conservons, chiffrées là où la section 10 le dit.'],
            ['L’équipe du Client', 'Seulement ce que le rôle de chacun permet : un lecteur voit les comptages et les résultats ; un éditeur voit aussi les participants ; ni l’un ni l’autre ne peut exporter, révéler les numéros complets, voir les informations de paiement ni gérer l’équipe.'],
            ['Autorités', 'Seulement lorsque la Loi ou un tribunal compétent l’exige.'],
          ],
        },
        { p: 'Nous ne vendons pas de données personnelles et n’en donnons ni aux annonceurs ni aux courtiers en données. Lorsqu’un prestataire traite des données pour notre compte, nous choisissons des prestataires qui offrent des garanties suffisantes de sécurité et de conformité (art. 16, 26 et 30) et nous limitons ce que chacun reçoit à ce que sa tâche exige. La liste actuelle est cette page ; nous la mettons à jour lorsqu’elle change.' },
      ],
    },
    {
      id: 'abroad',
      h: 'Transferts hors du Cameroun',
      blocks: [
        { p: 'WhatsApp est exploité par Meta, et les autres prestataires ci-dessus peuvent conserver ou traiter des données hors du Cameroun. Le lieu où notre hébergeur conserve les données peut aussi être hors du Cameroun. La Loi soumet le transfert de données à caractère personnel vers un pays étranger à l’autorisation préalable de l’Autorité de protection des données personnelles (art. 32). SurveyFlow demandera les autorisations et suivra les conditions que l’Autorité exige de lui, et limitera les transferts à ce que le service nécessite. En utilisant le service, les Clients acceptent ces transferts comme faisant partie de son fonctionnement ; les Participants en sont informés à la section 2.' },
      ],
    },
    {
      id: 'retention',
      h: 'Combien de temps nous conservons les données',
      blocks: [
        {
          rows: [
            ['Compte et données du Client', 'Tant que le compte existe. Lorsque vous demandez sa fermeture, le compte reste en lecture seule pendant 30 jours (vous pouvez annuler) ; puis le compte et ses données sont effacés.'],
            ['Données et réponses des Participants', 'Jusqu’à ce que le Client les supprime ou que le compte soit effacé.'],
            ['Pièces comptables des paiements', '10 ans, conservées sans nom, numéro de téléphone ni adresse e-mail, à des fins comptables et fiscales.'],
            ['Journaux de connexion et de sécurité', 'Sessions terminées : 30 jours. Journal de sécurité : 400 jours.'],
            ['Comptes jamais confirmés', 'Supprimés après 24 heures.'],
            ['Sauvegardes', 'Chiffrées, en rotation d’environ 30 jours ; les données effacées disparaissent des sauvegardes lorsqu’elles expirent.'],
          ],
        },
        { p: 'La Loi exige que les données ne soient pas conservées plus longtemps que nécessaire (art. 13) et laisse les durées maximales à l’Autorité de protection des données personnelles (art. 28). Si l’Autorité fixe d’autres durées, nous les appliquerons.' },
      ],
    },
    {
      id: 'rights',
      h: 'Vos droits et comment les exercer',
      blocks: [
        { p: 'Selon la Loi, toute personne dont les données sont traitées a les droits suivants (art. 37 à 47). Pour les exercer, il peut vous être demandé de prouver votre identité (art. 42).' },
        {
          ul: [
            '**Accès** (art. 39) : savoir si vos données sont traitées, et les recevoir avec leur origine, les finalités, les catégories et les destinataires, ainsi qu’une copie.',
            '**Rectification** (art. 42) : faire rectifier, compléter, mettre à jour ou verrouiller les données inexactes ou incomplètes.',
            '**Effacement** (art. 37 et 38) : faire effacer vos données et cesser leur communication lorsqu’elles ne sont plus nécessaires, lorsque vous retirez votre consentement ou lorsqu’il n’existe pas de base légale, sous réserve de ce qui doit être conservé par la loi.',
            '**Opposition** (art. 40 et 41) : vous opposer à tout moment, en particulier à l’utilisation à des fins de prospection commerciale ; après une opposition, les données ne peuvent plus servir à cette fin.',
            '**Limitation** (art. 46) : faire limiter le traitement tant que l’exactitude ou la finalité est contestée.',
            '**Portabilité** (art. 43) : recevoir vos données dans un format structuré, couramment utilisé et lisible par machine.',
            '**Décisions automatisées** (art. 44) : ne pas faire l’objet d’une décision fondée uniquement sur un traitement automatisé. SurveyFlow n’en prend aucune.',
            '**Après le décès** (art. 45) : laisser des directives sur le sort de vos données.',
            '**Réclamation** (art. 53) : saisir l’Autorité de protection des données personnelles.',
          ],
        },
        { p: '**Clients :** vous pouvez télécharger toutes les données de votre compte en un seul fichier et demander l’effacement du compte, dans l’application (Paramètres, Vos données). **Participants :** répondez STOP pour arrêter les messages d’un expéditeur. Pour l’accès, la rectification ou l’effacement, adressez-vous d’abord à l’expéditeur, en tant que responsable du traitement. Si vous ne pouvez pas le joindre, écrivez-nous (section 15) : nous transmettrons votre demande à l’expéditeur et l’aiderons à y donner suite, et nous agirons nous-mêmes sur les données que nous conservons pour nos propres finalités. Nous répondons dans les délais que la réglementation fixe (art. 47) et sans retard injustifié.' },
      ],
    },
    {
      id: 'security',
      h: 'Comment nous protégeons les données',
      blocks: [
        { p: 'La Loi exige des mesures techniques et organisationnelles appropriées, comme le chiffrement et l’accès restreint (art. 22 et 25 à 27). En pratique :' },
        {
          ul: [
            'Les mots de passe sont hachés avec un algorithme moderne à sens unique (argon2id).',
            'Les noms et numéros des Participants, les jetons d’accès WhatsApp et Google et les secrets d’authentificateur sont chiffrés. Les sauvegardes de la base de données sont chiffrées.',
            'Les connexions au site et à l’application utilisent HTTPS.',
            'L’accès est limité par rôle. Les actions sensibles (export, suppression, ajout d’un membre de l’équipe, changement des réglages de sécurité) vous demandent de confirmer que c’est bien vous, et la vérification en deux étapes est disponible.',
            'Les données de chaque Client sont isolées de celles de tous les autres ; cela est testé automatiquement.',
            'Les connexions et les actions sensibles sont journalisées. Les connexions échouées répétées sont ralenties et soumises à un contrôle.',
            'Les réponses sont conservées dans la base de données sans chiffrement au niveau du champ ; elles sont protégées par les contrôles d’accès ci-dessus et, dans les sauvegardes, par le chiffrement.',
            'Aucun système n’est parfaitement sûr, et nous ne pouvons promettre une sécurité absolue.',
          ],
        },
      ],
    },
    {
      id: 'breach',
      h: 'Si quelque chose tourne mal',
      blocks: [
        { p: 'Si nous avons connaissance d’une violation de données à caractère personnel, la Loi nous oblige à en informer sans délai l’Autorité de protection des données personnelles et les personnes concernées (art. 22). Pour les données des Participants, nous informons le Client sans retard injustifié afin qu’il puisse les informer, et nous informons l’Autorité et, lorsque la Loi l’exige, les personnes concernées. Pour les données propres d’un Client, nous informons le Client par e-mail.' },
      ],
    },
    {
      id: 'other-laws',
      h: 'Clients et Participants dans d’autres pays',
      blocks: [
        { p: 'La loi de protection des données d’un autre pays (par exemple le Nigeria, le Kenya, le Ghana, la Côte d’Ivoire ou l’Union européenne) peut aussi s’appliquer à l’usage de SurveyFlow par un Client, selon l’endroit où se trouvent ses contacts. Le Client est responsable des lois qui s’appliquent à son propre usage. Nous prenons la Loi comme socle commun pour tous.' },
      ],
    },
    {
      id: 'children',
      h: 'Enfants',
      blocks: [
        { p: 'SurveyFlow n’est pas destiné aux enfants, et les comptes sont réservés aux adultes. La Loi exige le consentement du père et de la mère ou du représentant légal pour une personne de moins de dix-huit ans (art. 9) et limite le traitement des données des mineurs à ce qui est nécessaire (art. 18). Les Conditions interdisent aux Clients de sonder une personne de moins de dix-huit ans sans ce consentement. SurveyFlow ne vérifie pas l’âge.' },
      ],
    },
    {
      id: 'changes',
      h: 'Modifications de cette politique',
      blocks: [
        { p: 'Lorsque nous modifions cette politique de façon significative, nous en informons les Clients par e-mail ou dans l’application avant que la modification s’applique, et nous mettons à jour la date en haut de cette page.' },
      ],
    },
    {
      id: 'contact',
      h: 'Contact',
      blocks: [
        { p: contactLine('fr', ctx) },
        { p: 'Les Clients peuvent aussi utiliser l’application (Paramètres, Vos données). Toute personne peut saisir l’Autorité de protection des données personnelles.' },
      ],
    },
  ],
});
