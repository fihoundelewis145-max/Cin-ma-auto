# CINEMA AUTO

Application Node.js pour gérer l'importation de vidéos et leur envoi vers une chaîne YouTube autorisée.

## Lancer en local
1. Installer Node.js 20 ou supérieur.
2. Exécuter `npm install`.
3. Définir les variables Google OAuth et `ADMIN_PASSWORD`.
4. Exécuter `npm start`.
5. Ouvrir `http://localhost:3000`.

## Variables d'environnement
- `ADMIN_PASSWORD` : mot de passe administrateur fort.
- `SESSION_SECRET` : secret aléatoire long (généré automatiquement par Render dans le Blueprint).
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` : par exemple `https://VOTRE-SERVICE.onrender.com/auth/youtube/callback`.

Dans Google Cloud Console, activez YouTube Data API v3, configurez l'écran de consentement OAuth et ajoutez l'URL de callback exacte aux URI autorisés.

## Déploiement Render
1. Dans Render, choisir New + puis Blueprint.
2. Connecter ce dépôt GitHub et laisser Render détecter `render.yaml`.
3. Créer le service.
4. Ajouter `ADMIN_PASSWORD` et les variables Google OAuth dans les paramètres du service.

## Limites avant une exploitation réelle
- La session et les jetons OAuth sont en mémoire : ils ne sont pas persistants après redémarrage et nécessitent un stockage durable/chiffré avant production.
- Le disque temporaire du service gratuit ne convient pas au stockage durable de gros fichiers vidéo : prévoir un stockage objet ou un disque persistant.
- Les envois YouTube sont réglés en mode **privé** par défaut.
- La file d'attente, l'automatisation récurrente, les statistiques, les journaux persistants et la reprise après erreur restent à développer.
- Importer et publier uniquement des œuvres dont vous possédez les droits de redistribution.

## Routes
- `GET /api/health`
- `GET /api/status`
- `POST /api/login`
- `POST /api/logout`
- `GET /auth/youtube`
- `GET /auth/youtube/callback`
- `POST /api/youtube/upload`
