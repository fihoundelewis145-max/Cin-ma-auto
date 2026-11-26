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
const PORT = process.env.PORT || 3000;
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 60 }));
app.use(session({
  name: "cinema.auto.sid",
  secret: process.env.SESSION_SECRET || "development-only-change-this",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("video/") ? cb(null, true) : cb(new Error("Un fichier vidéo est requis."))
});

function requireAdmin(req, res, next) {
  return req.session?.admin === true
    ? next()
    : res.status(401).json({ error: "Connectez-vous à l'espace administrateur." });
}
function createOAuthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) return null;
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}
function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, app: "CINEMA AUTO" }));
app.get("/api/status", (req, res) => res.json({
  adminAuthenticated: req.session?.admin === true,
  youtubeConfigured: Boolean(createOAuthClient()),
  youtubeConnected: Boolean(req.session?.youtubeTokens),
  publicationDefault: "private"
}));

app.post("/api/login", (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).json({ error: "Définissez ADMIN_PASSWORD dans Render." });
  if (!safeEqual(req.body?.password, process.env.ADMIN_PASSWORD))
    return res.status(401).json({ error: "Mot de passe incorrect." });
  req.session.admin = true;
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.get("/auth/youtube", requireAdmin, (req, res) => {
  const client = createOAuthClient();
  if (!client) return res.status(503).send("Les variables Google OAuth ne sont pas configurées.");
  const state = crypto.randomBytes(24).toString("hex");
  req.session.oauthState = state;
  res.redirect(client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    state,
    scope: ["https://www.googleapis.com/auth/youtube.upload"]
  }));
});

app.get("/auth/youtube/callback", requireAdmin, async (req, res) => {
  try {
    const client = createOAuthClient();
    if (!client || !req.query.code || !req.query.state || req.query.state !== req.session.oauthState)
      return res.status(400).send("Autorisation Google invalide ou expirée.");
    delete req.session.oauthState;
    const { tokens } = await client.getToken(req.query.code);
    req.session.youtubeTokens = tokens;
    res.redirect("/?youtube=connected");
  } catch (error) {
    console.error("OAuth callback:", error.message);
    res.status(500).send("Connexion YouTube échouée. Vérifiez la configuration OAuth.");
  }
});

app.post("/api/youtube/upload", requireAdmin, upload.single("video"), async (req, res) => {
  const tempFile = req.file && req.file.path;
  try {
    const tokens = req.session.youtubeTokens;
    if (!tokens) return res.status(401).json({ error: "Connectez d'abord votre chaîne YouTube." });
    if (req.body.rightsConfirmed !== "true")
      return res.status(400).json({ error: "Confirmez vos droits nécessaires pour publier cette vidéo." });
    const title = String(req.body.title || "").trim().slice(0, 100);
    if (!title || !req.file) return res.status(400).json({ error: "Le titre et la vidéo sont obligatoires." });

    const client = createOAuthClient();
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
    console.error("YouTube upload:", error.message);
    res.status(500).json({ error: "Échec de l'envoi. Vérifiez les autorisations et quotas YouTube." });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error.message);
  res.status(400).json({ error: error.message || "Requête invalide." });
});
app.listen(PORT, () => console.log("CINEMA AUTO écoute sur le port " + PORT));
