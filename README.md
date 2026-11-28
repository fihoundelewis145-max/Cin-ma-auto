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
