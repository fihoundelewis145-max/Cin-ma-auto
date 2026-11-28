require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const multer = require("multer");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const production = process.env.NODE_ENV === "production";
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 60 }));
app.use(session({
  name: "cinema.auto.sid",
  secret: process.env.SESSION_SECRET || "local-development-only-secret-change-before-deploy",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: production, sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("video/") ? cb(null, true) : cb(new Error("Le fichier doit être une vidéo."))
});

function configState() {
  const required = ["ADMIN_PASSWORD", "SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"];
  const missing = required.filter(key => !String(process.env[key] || "").trim());
  const googleMissing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]
    .filter(key => !String(process.env[key] || "").trim());
  return { missing, googleMissing, adminConfigured: !missing.includes("ADMIN_PASSWORD"),
    sessionSecretConfigured: !missing.includes("SESSION_SECRET"), youtubeConfigured: googleMissing.length === 0 };
}
function createOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) return null;
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
function requireAdmin(req, res, next) {
  if (req.session?.admin === true) return next();
  return res.status(401).json({ error: "Connectez-vous à l'espace administrateur." });
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function publicGoogleError(error) {
  const detail = error?.response?.data?.error_description ||
    error?.response?.data?.error?.message ||
    error?.response?.data?.error ||
    error?.message || "Erreur Google inconnue.";
  return String(detail).slice(0, 500);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "CINEMA AUTO" }));
app.get("/api/status", (req, res) => {
  const cfg = configState();
  res.json({
    app: "CINEMA AUTO",
    adminAuthenticated: req.session?.admin === true,
    adminConfigured: cfg.adminConfigured,
    youtubeConfigured: cfg.youtubeConfigured,
    youtubeConnected: Boolean(req.session?.youtubeTokens),
    missingGoogleVariables: cfg.googleMissing,
    publicationDefault: "private",
    note: "La connexion YouTube utilise Google OAuth officiel. Les vidéos sont envoyées en privé par défaut."
  });
});

app.post("/api/login", (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: "ADMIN_PASSWORD manque dans Render > Environment." });
  if (!safeEqual(req.body?.password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: "Mot de passe incorrect." });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Impossible d'ouvrir la session administrateur." });
    req.session.admin = true;
    res.json({ ok: true });
  });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/auth/youtube", requireAdmin, (req, res) => {
  const client = createOAuthClient();
  if (!client) return res.status(503).send(
    "<h1>Connexion YouTube non configurée</h1><p>Dans Render &gt; cinema-auto &gt; Environment, ajoutez GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et GOOGLE_REDIRECT_URI. Consultez README.md sur GitHub.</p>"
  );
  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    state,
    scope: ["https://www.googleapis.com/auth/youtube.upload"]
  });
  res.redirect(url);
});

app.get("/auth/youtube/callback", requireAdmin, async (req, res) => {
  if (req.query.error) return res.status(400).send(
    "<h1>Autorisation Google refusée</h1><p>" + String(req.query.error).replace(/[<>]/g, "") + "</p><p>Retournez dans CINEMA AUTO et relancez Connexion YouTube.</p>"
  );
  try {
    const client = createOAuthClient();
    if (!client) return res.status(503).send("Configuration Google OAuth absente dans Render.");
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState)
      return res.status(400).send("État OAuth invalide ou session expirée. Rechargez CINEMA AUTO et réessayez.");
    delete req.session.oauthState;
    const { tokens } = await client.getToken(req.query.code);
    if (!tokens.access_token) return res.status(502).send("Google n'a pas fourni de jeton d'accès. Vérifiez l'écran de consentement OAuth.");
    req.session.youtubeTokens = tokens;
    req.session.save(err => {
      if (err) return res.status(500).send("Google a répondu, mais la session n'a pas pu être enregistrée. Réessayez.");
      res.redirect("/?youtube=connected");
    });
  } catch (error) {
    console.error("Google OAuth callback:", publicGoogleError(error));
    res.status(500).send("<h1>Connexion YouTube échouée</h1><p>" +
      publicGoogleError(error).replace(/[<>]/g, "") +
      "</p><p>Vérifiez l'URI de redirection autorisée dans Google Cloud Console et les variables Render.</p>");
  }
});

app.post("/api/youtube/upload", requireAdmin, upload.single("video"), async (req, res) => {
  const tempFile = req.file?.path;
  try {
    const tokens = req.session.youtubeTokens;
    if (!tokens) return res.status(401).json({ error: "La chaîne YouTube n'est pas connectée. Cliquez d'abord sur Connecter YouTube." });
    if (req.body.rightsConfirmed !== "true")
      return res.status(400).json({ error: "Confirmez que vous possédez les droits nécessaires pour publier cette vidéo." });
    const title = String(req.body.title || "").trim().slice(0, 100);
    if (!title || !req.file) return res.status(400).json({ error: "Le titre et le fichier vidéo sont obligatoires." });

    const client = createOAuthClient();
    if (!client) return res.status(503).json({ error: "Google OAuth n'est pas configuré dans Render." });
    client.setCredentials(tokens);
    client.on("tokens", updated => {
      req.session.youtubeTokens = { ...req.session.youtubeTokens, ...updated };
    });
    const youtube = google.youtube({ version: "v3", auth: client });
    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description: String(req.body.description || "").slice(0, 5000), categoryId: "22" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false }
      },
      media: { body: fs.createReadStream(tempFile) }
    });
    res.json({ ok: true, videoId: result.data.id, url: "https://www.youtube.com/watch?v=" + result.data.id, privacyStatus: "private" });
  } catch (error) {
    const detail = publicGoogleError(error);
    console.error("YouTube upload:", detail);
    res.status(500).json({ error: "YouTube a refusé l'envoi : " + detail });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);
  res.status(400).json({ error: error.message || "Requête invalide." });
});
app.listen(PORT, "0.0.0.0", () => console.log("CINEMA AUTO écoute sur le port " + PORT));
