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
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);
const ffprobePath = require("ffprobe-static").path;

async function assertVideoAtLeastOneHour(filePath) {
  const { stdout } = await execFileAsync(ffprobePath, [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath
  ], { timeout: 120000, maxBuffer: 1024 * 1024 });
  const seconds = Number(String(stdout).trim());
  if (!Number.isFinite(seconds) || seconds <= 3600) {
    throw new Error("Vidéo refusée : durée détectée " + (Number.isFinite(seconds) ? Math.floor(seconds / 60) + " minutes" : "inconnue") + ". CINEMA AUTO accepte uniquement les vidéos de plus de 1 heure.");
  }
  return seconds;
}

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

function tokenEncryptionKey() {
  const secret = String(process.env.SESSION_SECRET || "");
  if (!secret) throw new Error("SESSION_SECRET est requis pour protéger le jeton YouTube.");
  return crypto.createHash("sha256").update(secret).digest();
}
function encryptTokenObject(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
}
function decryptTokenObject(value) {
  const [ivPart, tagPart, dataPart] = String(value || "").split(".");
  if (!ivPart || !tagPart || !dataPart) return null;
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenEncryptionKey(), Buffer.from(ivPart, "base64"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8"));
}
async function savePersistentYoutubeTokens(tokens) {
  if (!pool || !tokens) return;
  await ensureSchema();
  const previous = await loadPersistentYoutubeTokens();
  const merged = { ...(previous || {}), ...tokens };
  await pool.query(
    "INSERT INTO app_settings (key,value) VALUES ('youtube_tokens',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()",
    [encryptTokenObject(merged)]
  );
}
async function loadPersistentYoutubeTokens() {
  if (!pool) return null;
  await ensureSchema();
  const result = await pool.query("SELECT value FROM app_settings WHERE key='youtube_tokens'");
  if (!result.rows[0]) return null;
  try { return decryptTokenObject(result.rows[0].value); }
  catch (error) { console.error("Unable to decrypt saved YouTube tokens:", error.message); return null; }
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
  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS source_auto_config (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    rights_policy_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    queries TEXT[] NOT NULL DEFAULT ARRAY['feature film','feature-length movie','public domain television episode','classic television episode'],
    last_scan_at TIMESTAMPTZ,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  await pool.query("ALTER TABLE source_jobs ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'film'");`);
  await pool.query("INSERT INTO source_auto_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
  await pool.query("UPDATE source_auto_config SET queries=ARRAY['feature film','feature-length movie','public domain television episode','classic television episode'] WHERE id=1 AND queries=ARRAY['silent film','public domain short film']");
  await pool.query(`CREATE TABLE IF NOT EXISTS source_jobs (
    id BIGSERIAL PRIMARY KEY,
    source_key TEXT UNIQUE NOT NULL,
    provider TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    file_name TEXT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'film',
    description TEXT NOT NULL DEFAULT '',
    license TEXT NOT NULL,
    license_url TEXT NOT NULL DEFAULT '',
    attribution TEXT NOT NULL DEFAULT '',
    item_url TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    video_id TEXT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}
ensureSchema().catch(err => console.error("Database schema initialization failed:", err.message));

app.get("/api/health", async (_req, res) => {
  let db = false;
  try { if (pool) { await pool.query("SELECT 1"); db = true; } } catch (_) {}
  res.json({ ok: true, app: "CINEMA AUTO", database: db });
});

app.get("/api/status", async (req, res) => {
  const cfg = configState();
  let savedTokens = null;
  try { savedTokens = await loadPersistentYoutubeTokens(); } catch (_) {}
  res.json({
    app: "CINEMA AUTO",
    adminAuthenticated: req.session?.admin === true,
    adminConfigured: cfg.adminConfigured,
    databaseConfigured: cfg.databaseConfigured,
    youtubeConfigured: cfg.youtubeConfigured,
    youtubeConnected: Boolean(savedTokens?.refresh_token || req.session?.youtubeConnected),
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
    await savePersistentYoutubeTokens(tokens);
    req.session.youtubeConnected = true;
    delete req.session.youtubeTokens;
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
    const tokens = await loadPersistentYoutubeTokens();
    if (!tokens) return res.status(401).json({ error: "La chaîne YouTube n'est pas connectée. Cliquez sur Connecter YouTube." });
    if (req.body.rightsConfirmed !== "true")
      return res.status(400).json({ error: "Confirmez que vous possédez les droits nécessaires pour publier cette vidéo." });
    const title = String(req.body.title || "").trim().slice(0, 100);
    const description = String(req.body.description || "").trim().slice(0, 5000);
    if (!title || !req.file) return res.status(400).json({ error: "Le titre et le fichier vidéo sont obligatoires." });
    await assertVideoAtLeastOneHour(tempFile);

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
      savePersistentYoutubeTokens(updated).catch(err => console.error("YouTube token refresh save failed:", err.message));
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
    const itemPathParts = itemUrl.pathname.split("/").filter(Boolean);
    if (itemUrl.protocol !== "https:" || itemUrl.hostname !== "www.loc.gov" || itemPathParts.length !== 2 || itemPathParts[0] !== "item" || !/^[A-Za-z0-9._-]+$/.test(itemPathParts[1]))
      return res.status(400).json({ error: "Référence Library of Congress invalide." });
    const tokens = await loadPersistentYoutubeTokens();
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
    await assertVideoAtLeastOneHour(tempFile);
    const client = createOAuthClient();
    if (!client) throw new Error("Google OAuth n'est pas configuré dans Render.");
    client.setCredentials(tokens);
    client.on("tokens", updated => savePersistentYoutubeTokens(updated).catch(err => console.error("YouTube token refresh save failed:", err.message)));
    let publishAt = null;
    if (req.body.publishAt) {
      const scheduled = new Date(req.body.publishAt);
      if (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < Date.now() + 2 * 60 * 1000)
        throw new Error("Choisissez une date future, au moins deux minutes à l’avance.");
      publishAt = scheduled.toISOString();
    }
    const title = String(item.title || metadata.title || "Film du catalogue Library of Congress").trim().slice(0, 100);
    const description = [
      "Source : Library of Congress — National Screening Room",
      "Fiche source : " + itemUrl.href,
      "Description : " + (item.summary || metadata.summary || []).join(" ").slice(0, 3000),
      "Crédits et notes : " + notes.join(" ").slice(0, 1500)
    ].join("\n\n");
    const youtube = google.youtube({ version: "v3", auth: client });
    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: {
        snippet: { title, description, categoryId: "1" },
        status: { privacyStatus: "private", selfDeclaredMadeForKids: false, ...(publishAt ? { publishAt } : {}) }
      },
      media: { body: fs.createReadStream(tempFile) }
    });
    if (pool && result.data.id) {
      await pool.query(
        "INSERT INTO video_uploads (video_id,title,description,category,publish_at,status) VALUES ($1,$2,$3,$4,$5,$6)",
        [result.data.id, title, description, "film", publishAt, publishAt ? "scheduled" : "uploaded-private"]
      );
    }
    res.json({ ok: true, title, videoId: result.data.id, url: "https://www.youtube.com/watch?v=" + result.data.id, privacyStatus: "private", publishAt });
  } catch (error) {
    console.error("Library of Congress import:", error.message);
    res.status(500).json({ error: "Import impossible : " + String(error.message).slice(0, 400) });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});


const { searchOpenSources, downloadOpenVideo } = require("./media-sources");

app.get("/api/sources/open/search", requireAdmin, async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  if (q.length < 2) return res.status(400).json({ error: "Saisissez au moins deux caractères." });
  try {
    const result = await searchOpenSources(q);
    res.json({
      query: q,
      sources: result.sources,
      providers: result.providers,
      notice: "Seuls les fichiers avec une licence machine-readable admise (domaine public, CC0, CC BY ou CC BY-SA) sont affichés. Vérifiez toujours la fiche et les éventuels droits tiers."
    });
  } catch (error) {
    res.status(502).json({ error: "Recherche des archives impossible : " + error.message });
  }
});

function sourceYoutubeDescription(source) {
  return [
    "Source : " + source.provider,
    "Fiche originale : " + source.itemUrl,
    "Licence déclarée : " + source.license + (source.licenseUrl ? " — " + source.licenseUrl : ""),
    source.attribution ? "Attribution : " + source.attribution : "",
    source.description || ""
  ].filter(Boolean).join("\n\n").slice(0, 5000);
}

app.post("/api/sources/open/import", requireAdmin, async (req, res) => {
  let tempFile = null;
  try {
    if (req.body?.rightsConfirmed !== true)
      return res.status(400).json({ error: "Confirmez que vous avez vérifié la licence et les éventuels droits sur les images, musiques et personnes." });
    const provider = String(req.body.provider || "");
    const providerKey = String(req.body.providerKey || "");
    const fileName = req.body.fileName ? String(req.body.fileName) : null;
    const tokens = await loadPersistentYoutubeTokens();
    if (!tokens) return res.status(401).json({ error: "Connectez d'abord la chaîne YouTube à CINEMA AUTO." });
    tempFile = path.join(uploadDir, "open-" + crypto.randomBytes(16).toString("hex") + ".video");
    const source = await downloadOpenVideo(provider, providerKey, fileName, tempFile);
    await assertVideoAtLeastOneHour(tempFile);
    const client = createOAuthClient();
    if (!client) return res.status(503).json({ error: "Google OAuth n'est pas configuré dans Render." });
    client.setCredentials(tokens);
    client.on("tokens", updated => savePersistentYoutubeTokens(updated).catch(err => console.error("Token refresh save failed:", err.message)));
    const youtube = google.youtube({ version: "v3", auth: client });
    const title = String(source.title || "Film libre de droits").trim().slice(0, 100);
    const description = sourceYoutubeDescription(source);
    const result = await youtube.videos.insert({
      part: ["snippet", "status"],
      requestBody: { snippet: { title, description, categoryId: "1" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } },
      media: { body: fs.createReadStream(tempFile) }
    });
    if (pool && result.data.id) {
      await pool.query(
        "INSERT INTO video_uploads (video_id,title,description,category,publish_at,status) VALUES ($1,$2,$3,'film',NULL,'uploaded-private')",
        [result.data.id, title, description]
      );
    }
    res.json({ ok: true, title, videoId: result.data.id, url: "https://www.youtube.com/watch?v=" + result.data.id, privacyStatus: "private", license: source.license });
  } catch (error) {
    console.error("Open source import:", error.message);
    res.status(500).json({ error: "Téléchargement ou envoi impossible : " + String(error.message).slice(0, 400) });
  } finally {
    if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  }
});

app.get("/api/sources/auto/status", requireAdmin, async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "La base de données est nécessaire pour la file automatique." });
  try {
    await ensureSchema();
    const [cfg, counts, tokens] = await Promise.all([
      pool.query("SELECT enabled, rights_policy_confirmed, queries, last_scan_at, last_error FROM source_auto_config WHERE id=1"),
      pool.query("SELECT status, COUNT(*)::int AS count FROM source_jobs GROUP BY status"),
      loadPersistentYoutubeTokens()
    ]);
    res.json({
      ...(cfg.rows[0] || {}),
      counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count])),
      youtubeReady: Boolean(tokens?.refresh_token || tokens?.access_token),
      workerMode: "process-interval"
    });
  } catch (error) { res.status(500).json({ error: "État de l'automatisation indisponible : " + error.message }); }
});

app.post("/api/sources/auto/config", requireAdmin, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "La base de données est nécessaire pour l'automatisation." });
  try {
    await ensureSchema();
    const enabled = req.body?.enabled === true;
    const rightsConfirmed = req.body?.rightsPolicyConfirmed === true;
    const queries = Array.isArray(req.body?.queries)
      ? [...new Set(req.body.queries.map(value => String(value || "").trim().slice(0, 80)).filter(value => value.length >= 2))].slice(0, 4)
      : [];
    if (enabled && !rightsConfirmed) return res.status(400).json({ error: "Confirmez la politique de sources et de licences avant d'activer l'envoi automatique." });
    if (enabled && !queries.length) return res.status(400).json({ error: "Ajoutez au moins un terme de recherche." });
    const tokens = await loadPersistentYoutubeTokens();
    if (enabled && !tokens) return res.status(409).json({ error: "Connectez d'abord YouTube en cliquant sur « Connecter YouTube », puis activez l'automatisation." });
    const updated = await pool.query(
      "UPDATE source_auto_config SET enabled=$1, rights_policy_confirmed=$2, queries=$3, last_error=NULL, updated_at=NOW() WHERE id=1 RETURNING enabled, rights_policy_confirmed, queries, last_scan_at",
      [enabled, rightsConfirmed, queries]
    );
    res.json({ ok: true, ...updated.rows[0] });
    if (enabled) setTimeout(() => runAutoSourcePipeline().catch(err => console.error("Initial auto source run:", err.message)), 1000);
  } catch (error) { res.status(500).json({ error: "Configuration automatique impossible : " + error.message }); }
});

let autoPipelineRunning = false;
async function runAutoSourcePipeline() {
  if (!pool || autoPipelineRunning) return;
  autoPipelineRunning = true;
  try {
    await ensureSchema();
    const configResult = await pool.query("SELECT * FROM source_auto_config WHERE id=1");
    const config = configResult.rows[0];
    if (!config?.enabled || !config.rights_policy_confirmed) return;
    const tokens = await loadPersistentYoutubeTokens();
    if (!tokens) throw new Error("Connexion YouTube persistante manquante.");
    const oauth = createOAuthClient();
    if (!oauth) throw new Error("Google OAuth n'est pas configuré.");
    oauth.setCredentials(tokens);
    oauth.on("tokens", updated => savePersistentYoutubeTokens(updated).catch(err => console.error("Auto token refresh:", err.message)));

    await pool.query("UPDATE source_jobs SET status='pending', updated_at=NOW() WHERE status='downloading' AND updated_at < NOW() - INTERVAL '30 minutes'");
    const discovered = [];
    for (const query of (config.queries || []).slice(0, 4)) {
      const result = await searchOpenSources(query);
      const category = /episode|television|tv show/i.test(query) ? "series" : "film";
      discovered.push(...result.sources.filter(source => source.autoEligible).map(source => ({ ...source, category })));
    }
    const unique = [...new Map(discovered.map(source => [source.id, source])).values()].slice(0, 24);
    for (const source of unique) {
      await pool.query(
        `INSERT INTO source_jobs (source_key,provider,provider_key,file_name,title,category,description,license,license_url,attribution,item_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (source_key) DO NOTHING`,
        [source.id, source.provider, source.providerKey, source.fileName || null, source.title, source.category || "film",
         source.description || "", source.license, source.licenseUrl || "", source.attribution || "", source.itemUrl]
      );
    }
    await pool.query("UPDATE source_auto_config SET last_scan_at=NOW(), last_error=NULL WHERE id=1");

    // Upload sequentially: each next film starts only after the previous upload finishes.
    for (let index = 0; index < 10; index++) {
      const claimed = await pool.query(
        `UPDATE source_jobs SET status='downloading', attempts=attempts+1, updated_at=NOW()
         WHERE id=(SELECT id FROM source_jobs WHERE status='pending' AND attempts<3 ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`
      );
      const job = claimed.rows[0];
      if (!job) break;
      let tempFile = null;
      try {
        tempFile = path.join(uploadDir, "auto-" + crypto.randomBytes(16).toString("hex") + ".video");
        const source = await downloadOpenVideo(job.provider, job.provider_key, job.file_name, tempFile);
        const durationSeconds = await assertVideoAtLeastOneHour(tempFile);
        console.log("Auto source accepted:", job.title, Math.floor(durationSeconds / 60), "minutes");
        if (!source.autoEligible) throw new Error("La licence actuelle n'autorise pas l'envoi automatique. Vérification manuelle requise.");
        const youtube = google.youtube({ version: "v3", auth: oauth });
        const description = sourceYoutubeDescription(source);
        const title = String(source.title || job.title).trim().slice(0, 100);
        const uploaded = await youtube.videos.insert({
          part: ["snippet", "status"],
          requestBody: { snippet: { title, description, categoryId: "1" }, status: { privacyStatus: "private", selfDeclaredMadeForKids: false } },
          media: { body: fs.createReadStream(tempFile) }
        });
        if (pool && uploaded.data.id) {
          await pool.query(
            "INSERT INTO video_uploads (video_id,title,description,category,publish_at,status) VALUES ($1,$2,$3,$4,NULL,'uploaded-private')",
            [uploaded.data.id, title, description, job.category || "film"]
          );
        }
        await pool.query(
          "UPDATE source_jobs SET status='uploaded-private', video_id=$1, last_error=NULL, updated_at=NOW() WHERE id=$2",
          [uploaded.data.id, job.id]
        );
      } catch (error) {
        const retryStatus = Number(job.attempts || 0) >= 3 ? "failed" : "pending";
        await pool.query(
          "UPDATE source_jobs SET status=$1, last_error=$2, updated_at=NOW() WHERE id=$3",
          [retryStatus, String(error.message || error).slice(0, 500), job.id]
        );
      } finally {
        if (tempFile && fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      }
    }
  } catch (error) {
    console.error("Automatic source pipeline:", error.message);
    if (pool) await pool.query("UPDATE source_auto_config SET last_error=$1 WHERE id=1", [String(error.message).slice(0, 500)]).catch(() => {});
  } finally {
    autoPipelineRunning = false;
  }
}


require("./metricool")(app, { requireAdmin, upload, pool });

app.use((error, _req, res, _next) => {
  console.error("Request error:", error.message);
  res.status(400).json({ error: error.message || "Requête invalide." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("CINEMA AUTO écoute sur le port " + PORT);
  // Le worker recherche les sources à intervalles réguliers tant que l'instance Render est active.
  setTimeout(() => runAutoSourcePipeline().catch(err => console.error("Auto source startup:", err.message)), 45000);
  setInterval(() => runAutoSourcePipeline().catch(err => console.error("Auto source interval:", err.message)), 10 * 60 * 1000);
});
