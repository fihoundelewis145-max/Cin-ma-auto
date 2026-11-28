# CINEMA AUTO 1.2

Studio de gestion, importation et programmation de vidéos vers YouTube. Il est conçu pour des contenus originaux, libres de droits ou pour lesquels l'administrateur possède une licence écrite de redistribution. Il ne contourne pas les protections de MovieBox ou d'autres plateformes.

## Infrastructure
- Node.js 20 / Express
- Render Web Service
- Render PostgreSQL pour rendre les sessions et l'historique persistants
- YouTube Data API v3 avec OAuth 2.0
- Programmation native YouTube via `status.publishAt` (la vidéo est téléversée privée, YouTube la rend publique à l'heure future).

## Déploiement Render
Le fichier `render.yaml` décrit un service Web et une base PostgreSQL. Après synchronisation du Blueprint, vérifier que le service et la base `cinema-auto-db` existent et que `DATABASE_URL` est reliée à la base.

Dans le service Render > Environment, définir :
- `ADMIN_PASSWORD` : mot de passe administrateur robuste.
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` = `https://cinema-auto.onrender.com/auth/youtube/callback`

`SESSION_SECRET` est généré par Render. `DATABASE_URL` est reliée depuis la ressource PostgreSQL du Blueprint.

## Configuration Google OAuth (indispensable)
1. Ouvrir Google Cloud Console et sélectionner un projet.
2. Activer **YouTube Data API v3**.
3. Configurer l'écran de consentement OAuth et, si le projet est en mode Test, ajouter l'adresse Google qui gère la chaîne dans les utilisateurs test.
4. Créer un identifiant OAuth **Web application**.
5. Ajouter exactement l'URI de redirection :
   `https://cinema-auto.onrender.com/auth/youtube/callback`
6. Renseigner client ID, client secret et URI de redirection dans Render.
7. Redéployer, ouvrir le site, se connecter comme administrateur, puis appuyer sur Connecter YouTube et accepter l'accès.

Le secret Google ne doit jamais être commité dans GitHub ni envoyé dans une conversation.

## Lancer localement
Node.js 20+, `npm install`, variables dans `.env`, puis `npm start`.

## Limitations à connaître
- L'envoi vidéo utilise un fichier temporaire local Render : il ne constitue pas un stockage durable. Les grands fichiers nécessitent un disque persistant ou un stockage objet (S3/R2).
- Les sessions et jetons OAuth sont désormais stockés dans PostgreSQL si `DATABASE_URL` est reliée.
- La file d'importation automatique depuis des sites tiers n'est pas incluse ; seules les sources autorisées peuvent être automatisées.
- Les vidéos sont programmées via l'API YouTube avec visibilité privée jusqu'à l'heure prévue.


## Liaison de la chaîne à vidIQ depuis CINEMA AUTO
Le tableau de bord contient maintenant un bouton **Ouvrir vidIQ et relier ma chaîne**. Il ouvre le site officiel vidIQ. Dans vidIQ :
1. Connectez-vous à votre compte.
2. Ouvrez l'icône de profil, puis **Link your channel**.
3. Choisissez le compte Google propriétaire ou gestionnaire de la chaîne et acceptez les autorisations.
4. Revenez à CINEMA AUTO.

Guide officiel : https://support.vidiq.com/en/articles/7988664-authenticating-your-channel-with-vidiq

La liaison vidIQ et l'autorisation Google OAuth de CINEMA AUTO sont distinctes. Le fait de relier une chaîne à vidIQ n'accorde pas automatiquement au backend CINEMA AUTO le droit de téléverser sur YouTube et ne donne pas automatiquement au site accès aux données privées vidIQ. Pour publier depuis CINEMA AUTO, la connexion Google OAuth du site reste nécessaire.

## Publication YouTube via Metricool (intégration CINEMA AUTO 1.3)

CINEMA AUTO peut utiliser Metricool comme service de programmation intermédiaire. Le site transmet la vidéo à Metricool, puis Metricool la programme sur la chaîne YouTube connectée à la marque.

### Prérequis Metricool
- Le compte Metricool doit être sur un forfait **Advanced ou Custom** pour disposer de l'API. Les forfaits Free et Starter n'incluent pas l'accès API.
- Connecter la chaîne YouTube depuis Metricool > Connexions de la marque.
- Dans Paramètres du compte > API, copier le jeton d'accès.
- Récupérer le `userId` et le `blogId` dans l'adresse de la marque Metricool.

### Variables Render
Configurer dans Render > Environment, sans déposer les secrets dans GitHub :
- `METRICOOL_API_TOKEN` : jeton API secret.
- `METRICOOL_USER_ID` : identifiant du compte Metricool.
- `METRICOOL_BLOG_ID` : identifiant de la marque qui contient la chaîne YouTube.
- `PUBLIC_BASE_URL` : `https://cinema-auto.onrender.com`.
- `METRICOOL_TIMEZONE` : `Africa/Porto-Novo`.

Le site expose l'état de cette configuration dans l'espace administrateur. L'endpoint de publication est `POST /api/metricool/publish`; les routes d'état, de liste des marques, de calendrier et d'historique sont regroupées sous `/api/metricool`.

### Utilisation
Dans « Importer / programmer », choisir **Metricool**, fournir le fichier vidéo, le titre, la description, la date/heure, le format YouTube (vidéo standard ou Short) et indiquer si la vidéo est destinée aux enfants. Le site exige une confirmation des droits de redistribution avant l'envoi.

Le fichier est temporairement servi par une URL HTTPS aléatoire afin que Metricool puisse le copier pendant la requête de programmation (`saveExternalMediaFiles: true)); le fichier temporaire est ensuite supprimé. Le stockage local Render n'est pas une bibliothèque vidéo permanente.

### Connexion directe YouTube
La méthode Google OAuth directe reste disponible en secours et exige toujours `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` et `GOOGLE_REDIRECT_URI`. Elle est indépendante de Metricool.

Documentation officielle :
- Guide d'intégration API : https://help.metricool.com/fr/guide-de-base-pour-lintegration-api-r97af
- Planifier et publier sur YouTube : https://help.metricool.com/fr/planifier-et-publier-sur-youtube-gof0k
