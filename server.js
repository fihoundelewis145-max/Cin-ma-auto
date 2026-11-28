require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const multer = require("multer");
const { google } = require("googleapis");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const production = process.env.NODE_ENV === "production";
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: production ? { rejectUnauthorized: false } : false,
      max: 5
    })
  : null;

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 60 }));

const sessionOptions = {
  name: "cinema.auto.sid",
  secret: process.env.SESSION_SECRET || "local-development-only-secret-change-before-deploy",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: production, sameSite: "lax", maxAge: 30 * 24 * 60 * 60 * 1000 }
};
if (pool) {
  sessionOptions.store = new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true,
    pruneSessionInterval: 15 * 60
  });
}
app.use(session(sessionOptions));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("video/") ? cb(null, true) : cb(new Error("Le fichier doit être une vidéo."))
});

function configState() {
  const required = ["ADMIN_PASSWORD", "SESSION_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "DATABASE_URL"];
  const missing = required.filter(key => !String(process.env[key] || "").trim());
  const googleMissing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"]
    .filter(key => !String(process.env[key] || "").trim());
  return { missing, googleMissing, adminConfigured: Boolean(process.env.ADMIN_PASSWORD), databaseConfigured: Boolean(pool), youtubeConfigured: googleMissing.length === 0 };
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
function describeGoogleError(error) {
  const detail = error?.response?.data?.error_description || error?.response?.data?.error?.message ||
    error?.response?.data?.error || error?.message || "Erreur Google inconnue.";
  return String(detail).slice(0, 500);
}
async function ensureSchema() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS video_uploads (
    id BIGSERIAL PRIMARY KEY,
    video_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT 'film',
    season_number INTEGER,
    episode_number INTEGER,
    publish_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status TEXT NOT NULL DEFAULT 'scheduled'
  )`);
}
ensureSchema().catch(err => console.error("Database schema initialization failed:", err.message));

app.get("/api/health", async (_req, res) => {
  let db = false;
  try { if (pool) { await pool.query("SELECT 1"); db = true; } } catch (_) {}
  res.json({ ok: true, app: "CINEMA AUTO", database: db });
});

app.get("/api/status", (req, res) => {
  const cfg = configState();
  res.json({
    app: "CINEMA AUTO",
    adminAuthenticated: req.session?.admin === true,
    adminConfigured: cfg.adminConfigured,
    databaseConfigured: cfg.databaseConfigured,
    youtubeConfigured: cfg.youtubeConfigured,
    youtubeConnected: Boolean(req.session?.youtubeTokens),
    missingGoogleVariables: cfg.googleMissing,
    missingVariables: cfg.missing,
    publicationDefault: "private"
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
    "<h1>Connexion YouTube non configurée</h1><p>Ajoutez GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et GOOGLE_REDIRECT_URI dans Render &gt; Environment.</p>"
  );
  const state = crypto.randomBytes(32).toString("hex");
  req.session.oauthState = state;
  res.redirect(client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    state,
    scope: ["https://www.googleapis.com/auth/youtube.upload"]
  }));
});

app.get("/auth/youtube/callback", requireAdmin, async (req, res) => {
  if (req.query.error) return res.status(400).send(
    "<h1>Autorisation Google refusée</h1><p>" + String(req.query.error).replace(/[<>]/g, "") + "</p>"
  );
  try {
    const client = createOAuthClient();
    if (!client) return res.status(503).send("Configuration Google OAuth absente dans Render.");
    if (!req.query.code || !req.query.state || req.query.state !== req.session.oauthState)
      return res.status(400).send("État OAuth invalide ou session expirée. Rechargez le site et réessayez.");
    delete req.session.oauthState;
    const { tokens } = await client.getToken(req.query.code);
    if (!tokens.access_token) return res.status(502).send("Google n'a pas fourni de jeton d'accès.");
    req.session.youtubeTokens = { ...req.session.youtubeTokens, ...tokens };
    req.session.save(err => {
      if (err) return res.status(500).send("La session Google n'a pas pu être enregistrée.");
      res.redirect("/?youtube=connected");
    });
  } catch (error) {
    const detail = describeGoogleError(error);
    console.error("Google OAuth callback:", detail);
    res.status(500).send("<h1>Connexion YouTube échouée</h1><p>" + detail.replace(/[<>]/g, "") +
      "</p><p>Vérifiez l'URI de redirection autorisée dans Google Cloud Console.</p>");
  }
});

app.get("/api/uploads", requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "Base de données non configurée. Ajoutez DATABASE_URL dans Render." });
  try {
    const result = await pool.query("SELECT id, video_id, title, category, season_number, episode_number, publish_at, created_at, status FROM video_uploads ORDER BY created_at DESC LIMIT 100");
    res.json({ uploads: result.rows });
  } catch (error) {
    console.error("List uploads:", error.message);
    res.status(500).json({ error: "Impossible de lire l'historique." });
  }
});

app.post("/api/youtube/upload", requireAdmin, upload.single("video"), async (req, res) => {
  const tempFile = req.file?.path;
  try {
    const tokens = req.session.youtubeTokens;
    if (!tokens) return res.status(401).json({ error: "La chaîne YouTube n'est pas connectée. Cliquez sur Connecter YouTube." });
    if (req.body.rightsConfirmed !== "true")
      return res.status(400).json({ error: "Confirmez que vous possédez les droits nécessaires pour publier cette vidéo." });
    const title = String(req.body.title || "").trim().slice(0, 100);
    const description = String(req.body.description || "").trim().slice(0, 5000);
    if (!title || !req.file) return res.status(400).json({ error: "Le titre et le fichier vidéo sont obligatoires." });

    let publishAt = null;
    if (req.body.publishAt) {
      const scheduled = new Date(req.body.publishAt);
      if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now() + 2 * 60 * 1000)
        return res.status(400).json({ error: "Choisissez une date future, au moins deux minutes à l'avance." });
      publishAt = scheduled.toISOString();
    }

    const client = createOAuthClient();
    if (!client) return res.status(503).json({ error: "Google OAuth n'est pas configuré dans Render." });
    client.setCredentials(tokens);
    client.on("tokens", updated => {
      req.session.youtubeTokens = { ...req.session.youtubeTokens, ...updated };
    });

    const category = ["film", "series"].includes(req.body.category) ? req.body.category : "film";
    const season = req.body.seasonNumber ? Number(req.body.seasonNumber) : null;
    const episode = req.body.episodeNumber ? Number(req.body.episodeNumber) : null;
    const youtube = google.youtube({ version: "v3", auth: client });
    const status = { privacyStatus: "private", selfDeclaredMadeForKids: false };
    if (publishAt) status.publishAt = publishAt;

    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, categoryId: "1" },
        status
      },
      media: { body: fs.createReadStream(tempFile) }
    });

    if (pool && result.data.id) {
      await pool.query(
        "INSERT INTO video_uploads (video_id,title,description,category,season_number,episode_number,publish_at,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [result.data.id,title,description,category,season,episode,publishAt,publishAt ? "scheduled" : "uploaded-private"]
      );
    }
    res.json({
      ok: true,
      videoId: result.data.id,
      url: "https://www.youtube.com/watch?v=" + result.data.id,
      privacyStatus: "private",
      publishAt
    });
  } catch (error) {
    const detail = describeGoogleError(error);
    console.error("YouTube upload:", detail);
    res.status(500).json({ error: "YouTube a refusé l'envoi : " + detail });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});


const LOC_COLLECTION_API = "https://www.loc.gov/collections/national-screening-room/";
app.get("/api/sources/loc/search", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "silent film").trim().slice(0, 120);
  if (q.length < 2) return res.status(400).json({ error: "Saisissez au moins deux caractères." });
  try {
    const url = new URL(LOC_COLLECTION_API);
    url.searchParams.set("fo", "json");
    url.searchParams.set("c", "25");
    url.searchParams.set("q", q);
    url.searchParams.set("sp", "1");
    const response = await fetch(url, { headers: { "User-Agent": "CINEMA-AUTO/1.0 (media rights review)" } });
    if (!response.ok) throw new Error("Catalogue de la Library of Congress indisponible (" + response.status + ").");
    const data = await response.json();
    const results = (data.results || []).filter(item =>
      Array.isArray(item.online_format) && item.online_format.includes("video") &&
      Array.isArray(item.resources) && item.resources.some(r => typeof r.video === "string" && r.video.endsWith(".mp4"))
    ).map(item => {
      const notes = item.item?.notes || [];
      const rightsWarning = notes.some(n => /copyright|permission|restricted|rights reserved/i.test(n));
      return {
        title: item.title || item.item?.title || "Sans titre",
        year: item.date || "",
        url: item.url,
        videoAvailable: true,
        durationSeconds: item.resources?.[0]?.duration || null,
        description: (item.description || item.item?.summary || []).join(" ").slice(0, 500),
        notes: notes.slice(0, 5),
        rightsWarning,
        source: "Library of Congress — National Screening Room"
      };
    });
    res.json({ source: "Library of Congress — National Screening Room", results,
      notice: "Le statut libre de droits doit être vérifié pour chaque film. La présence dans le catalogue ne garantit pas le droit de republication." });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

app.post("/api/sources/loc/import", requireAdmin, async (req, res) => {
  let tempFile = null;
  try {
    if (req.body?.rightsConfirmed !== true) return res.status(400).json({ error: "Confirmez les droits de redistribution de ce film avant l'envoi." });
    const itemUrl = new URL(String(req.body.itemUrl || ""));
    if (itemUrl.protocol !== "https:" || itemUrl.hostname !== "www.loc.gov" || !/^\\/item\\/[A-Za-z0-9._-]+\\/?$/.test(itemUrl.pathname))
      return res.status(400).json({ error: "Référence Library of Congress invalide." });
    const tokens = req.session.youtubeTokens;
    if (!tokens) return res.status(401).json({ error: "Connectez d'abord votre chaîne YouTube à CINEMA AUTO." });
    const metaUrl = new URL(itemUrl.pathname, "https://www.loc.gov");
    metaUrl.searchParams.set("fo", "json");
    const metaResponse = await fetch(metaUrl, { headers: { "User-Agent": "CINEMA-AUTO/1.0" } });
    if (!metaResponse.ok) throw new Error("Impossible de lire la fiche du film dans le catalogue.");
    const metadata = await metaResponse.json();
    const item = metadata.item || metadata;
    const notes = item.notes || metadata.notes || [];
    if (notes.some(n => /copyright notice|copyrighted|permission required|restricted use/i.test(n)))
      return res.status(403).json({ error: "La fiche contient une mention de copyright ou de restriction. Ce titre est bloqué pour éviter une republication non autorisée." });
    const record = metadata.resources?.find(r => typeof r.video === "string" && r.video.endsWith(".mp4"));
    if (!record?.video) return res.status(404).json({ error: "Aucun fichier MP4 direct n'est disponible pour ce titre." });
    const mediaUrl = new URL(record.video);
    if (mediaUrl.protocol !== "https:" || mediaUrl.hostname !== "tile.loc.gov")
      return res.status(400).json({ error: "Hôte vidéo non autorisé." });
    const mediaResponse = await fetch(mediaUrl, { redirect: "error" });
    if (!mediaResponse.ok || !mediaResponse.body) throw new Error("Téléchargement du média refusé par la source.");
    const length = Number(mediaResponse.headers.get("content-length") || 0);
    if (length > 1500 * 1024 * 1024) throw new Error("Ce fichier dépasse la limite d'import de 1,5 Go.");
    tempFile = path.join(uploadDir, "loc-" + crypto.randomBytes(16).toString("hex") + ".mp4");
    await pipeline(Readable.fromWeb(mediaResponse.body), fs.createWriteStream(tempFile));
    const client = createOAuthClient();
    if (!client) throw new Error("Google OAuth n'est pas configuré dans Render.");
    client.setCredentials(tokens);
    const title = String(item.title || metadata.title || "Film du catalogue Library of Congress").trim().slice(0, 100);
    const description = [
      "Source : Library of Congress — National Screening Room",
      "Fiche source : " + itemUrl.href,
      "Description : " + (item.summary || metadata.summary || []).join(" ").slice(0, 3000),
      "Crédits et notes : " + notes.join(" ").slice(0, 1500)
    ].join("\\n\\n");
    const youtube = google.youtube({ version: "v3", auth: client });
    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, categoryId: "1" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false }
      },
      media: { body: fs.createReadStream(tempFile) }
    });
    if (pool && result.data.id) {
      await pool.query(
        "INSERT INTO video_uploads (video_id,title,description,category,status) VALUES ($1,$2,$3,$4,$5)",
        [result.data.id, title, description, "film", "uploaded-private"]
      );
    }
    res.json({ ok: true, title, videoId: result.data.id, url: "https://www.youtube.com/watch?v=" + result.data.id, privacyStatus: "private" });
  } catch (error) {
    console.error("Library of Congress import:", error.message);
    res.status(500).json({ error: "Import impossible : " + String(error.message).slice(0, 400) });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

require("./metricool")(app, { requireAdmin, upload, pool });

app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);
  res.status(400).json({ error: error.message || "Requête invalide." });
});

app.listen(PORT, "0.0.0.0", () => console.log("CINEMA AUTO écoute sur le port " + PORT));
