# CINEMA AUTO

CINEMA AUTO est un studio de gestion de vidéos et de publication vers une chaîne YouTube. Il est prévu pour des fichiers et sources que l'administrateur est autorisé à redistribuer. Il ne télécharge pas et ne republie pas de films ou séries protégés depuis MovieBox ou d'autres services sans autorisation.

## Pourquoi YouTube peut ne pas fonctionner

La connexion Google n'est pas activée tant que les trois variables suivantes ne sont pas correctement définies dans Render :
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI`

### Configuration Google
1. Ouvrir Google Cloud Console et sélectionner/créer un projet.
2. Activer **YouTube Data API v3**.
3. Configurer l'écran de consentement OAuth (si l'application est en mode test, ajouter le compte Google propriétaire de la chaîne comme utilisateur test).
4. Créer un identifiant OAuth de type **Web application**.
5. Dans les URI de redirection autorisés, ajouter exactement :
   `https://cinema-auto.onrender.com/auth/youtube/callback`
6. Dans Render > service `cinema-auto` > Environment, définir :
   - `GOOGLE_CLIENT_ID` : identifiant OAuth du client Web.
   - `GOOGLE_CLIENT_SECRET` : secret OAuth de ce même client.
   - `GOOGLE_REDIRECT_URI` : `https://cinema-auto.onrender.com/auth/youtube/callback`
7. Enregistrer puis attendre le redéploiement.
8. Ouvrir CINEMA AUTO, se connecter à l'espace administrateur, puis cliquer sur **Connecter YouTube** et autoriser le compte voulu.

Les identifiants OAuth sont propres au compte Google et ne peuvent pas être fabriqués par le dépôt GitHub. Ne jamais placer le secret Google dans un fichier du dépôt.

## Variables Render
- `ADMIN_PASSWORD` : mot de passe administrateur.
- `SESSION_SECRET` : secret aléatoire long.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` : variables OAuth listées ci-dessus.

## Démarrage local
Node.js 20+, `npm install`, puis `npm start`.

## Limites connues à corriger avant une exploitation permanente
- Les sessions et jetons OAuth sont stockés dans le magasin mémoire Express par défaut : ils sont perdus lorsque le service redémarre ou se met en veille. Un magasin de sessions persistant et un stockage chiffré des jetons sont nécessaires pour une utilisation longue durée.
- Les fichiers envoyés sont temporaires sur le disque du service Render gratuit. Utiliser un stockage objet ou disque persistant pour des fichiers volumineux.
- Cette version envoie les vidéos en mode **privé** par défaut afin de permettre une vérification avant toute publication publique.
- La file de planification et l'ingestion automatique de sources autorisées ne sont pas encore disponibles dans cette version.

## Routes
- `GET /api/health`
- `GET /api/status`
- `POST /api/login`
- `POST /api/logout`
- `GET /auth/youtube`
- `GET /auth/youtube/callback`
- `POST /api/youtube/upload`
