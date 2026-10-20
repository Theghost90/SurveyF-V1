# SurveyFlow: tester guide (English)

Thank you for testing SurveyFlow. It lets a business run a survey **inside WhatsApp**, see the answers live, and optionally give a small gift to people who answer. **Everything here is a simulation**: no real WhatsApp message is sent, no real money moves.

**Address:** (the person who invited you sends it) · **Works on:** any phone or computer browser (please try both).

## What to do (about 30 to 45 minutes)

1. **Sign up** with a made-up business name and an email you can remember (it is not verified; there is no password reset yet, so write the password down). Use a fake phone number, for example `+237 677 00 00 99`.
2. **Setup:** pick your type of customer, then choose **"Use a simulated number"** to connect WhatsApp.
3. **Contacts:** import the file `tester-contacts.csv` (you were sent it). One row is wrong on purpose: check that the error is understandable. Then add one contact by hand.
4. **Create a survey** from the "Order & delivery" template. Try to break it: empty question, 4 buttons, very long text.
5. **Send it** to all contacts, then open **Simulator**: run the send queue, answer as a participant (tap the buttons, type), answer some questions, leave one conversation unfinished, press "Skip 25 h".
6. **Analytics:** do the numbers match what you did? Look at the funnel, the per-question results, the "haven't replied" list. Download the PDF and Excel.
7. **Analytics on WhatsApp** (Settings, then that tab): link a phone with the code, then in the Simulator's "Owner" tab try `STATS`, `RESULTS`, `DROP`.
8. **Billing:** open Billing, pick a plan, go through the demo checkout (no real card or money).
9. **Language and phone:** switch FR/EN; then use everything on a **phone**: menus, the survey list, the builder.
10. **Free exploration:** do what a real business owner would do.

## What we want to know

Where did you hesitate or get lost? What was unclear, slow, ugly, or broken? What did you expect to find and did not? Would you pay for this, and how much?

## How to report a problem (one message per problem)

- **What you did** (steps), **what you expected**, **what happened**.
- Your **device and browser** (for example "iPhone 13, Safari"), and the **time**.
- A **screenshot** if you can.

## Good to know

- Not built yet (shown as "soon" or disabled): team members, API access, white label, e-mail and "50 %" alerts.
- The WhatsApp side is played by the Simulator only; the real WhatsApp connection has not been tested yet.
- The test data may be erased at any time. The address stops working when the host switches the test off.
- Please do **not** enter real personal data, real customers' numbers, or real payment details.

---

# SurveyFlow : guide du testeur (français)

Merci de tester SurveyFlow. L'outil permet à une entreprise de lancer un sondage **dans WhatsApp**, de voir les réponses en direct et, au choix, d'offrir un petit cadeau à ceux qui répondent. **Tout est ici simulé** : aucun vrai message WhatsApp n'est envoyé, aucun argent réel ne circule.

**Adresse :** (celle que la personne qui vous invite vous envoie) · **Fonctionne sur :** tout navigateur de téléphone ou d'ordinateur (essayez les deux).

## À faire (environ 30 à 45 minutes)

1. **Inscrivez-vous** avec un nom d'entreprise inventé et un e-mail dont vous vous souviendrez (il n'est pas vérifié ; il n'y a pas encore de mot de passe oublié, notez-le). Utilisez un faux numéro, par exemple `+237 677 00 00 99`.
2. **Configuration :** choisissez votre type de clientèle, puis **« Utiliser un numéro simulé »** pour connecter WhatsApp.
3. **Contacts :** importez le fichier `tester-contacts.csv` (envoyé avec ce guide). Une ligne est fausse exprès : vérifiez que l'erreur est compréhensible. Ajoutez ensuite un contact à la main.
4. **Créez un sondage** à partir du modèle « Commande et livraison ». Essayez de le casser : question vide, 4 boutons, texte très long.
5. **Envoyez-le** à tous les contacts, puis ouvrez **Simulateur** : lancez la file d'envoi, répondez comme un participant (boutons, texte), laissez une conversation inachevée, cliquez sur « Sauter 25 h de silence ».
6. **Analytique :** les chiffres correspondent-ils à ce que vous avez fait ? Regardez l'entonnoir, les résultats par question, la liste de ceux qui n'ont pas répondu. Téléchargez le PDF et l'Excel.
7. **Analytique sur WhatsApp** (Paramètres, puis cet onglet) : liez un téléphone avec le code, puis, dans l'onglet « Propriétaire » du Simulateur, essayez `STATS`, `RESULTS`, `DROP`.
8. **Abonnement :** ouvrez la page, choisissez une offre, passez la caisse de démonstration (aucune vraie carte, aucun argent).
9. **Langue et téléphone :** passez de FR à EN ; puis utilisez tout sur un **téléphone** : menus, liste des sondages, éditeur.
10. **Exploration libre :** faites ce que ferait un vrai chef d'entreprise.

## Ce que nous voulons savoir

Où avez-vous hésité ou été perdu(e) ? Qu'est-ce qui était flou, lent, laid ou cassé ? Que cherchiez-vous sans le trouver ? Paieriez-vous pour cet outil, et combien ?

## Comment signaler un problème (un message par problème)

- **Ce que vous avez fait** (étapes), **ce que vous attendiez**, **ce qui s'est passé**.
- Votre **appareil et navigateur** (par exemple « iPhone 13, Safari ») et l'**heure**.
- Une **capture d'écran** si possible.

## Bon à savoir

- Pas encore construit (affiché « bientôt » ou grisé) : membres d'équipe, accès API, marque blanche, alertes par e-mail et à « 50 % ».
- Le côté WhatsApp n'est joué que par le Simulateur ; la vraie connexion WhatsApp n'a pas encore été testée.
- Les données de test peuvent être effacées à tout moment. L'adresse cesse de fonctionner quand l'hôte arrête le test.
- Merci de **ne pas** saisir de données personnelles réelles, de vrais numéros de clients ni de vraies coordonnées de paiement.
