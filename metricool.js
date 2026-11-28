const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const MEDIA_TTL_MS = 60 * 60 * 1000;
const DEFAULT_METRICOOL_BLOG_ID = "8413347";
const mediaTickets = new Map();

function metricoolConfig() {
  const keys = ["METRICOOL_API_TOKEN", "METRICOOL_USER_ID"];
  const missing = keys.filter(key => !String(process.env[key] || "").trim());
  return {
    configured: missing.length === 0,
    missing,
    timezone: process.env.METRICOOL_TIMEZONE || "Africa/Porto-Novo"
  };
}

function safeMessage(value) {
  if (typeof value === "string") return value.slice(0, 700);
  return JSON.stringify(value || {}).slice(0, 700);
}

function localDateTime(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((out, part) => {
    if (part.type !== "literal") out[part.type] = part.value;
    return out;
  }, {});
  return parts.year + "-" + parts.month + "-" + parts.day + "T" +
    parts.hour + ":" + parts.minute + ":" + parts.second;
}

function apiUrl(endpoint, includeBlog = true) {
  const url = new URL("https://app.metricool.com/api" + endpoint);
  url.searchParams.set("userId", String(process.env.METRICOOL_USER_ID));
  if (includeBlog) url.searchParams.set("blogId", String(process.env.METRICOOL_BLOG_ID || DEFAULT_METRICOOL_BLOG_ID));
  return url;
}

async function metricoolRequest(endpoint, { method = "GET", body, includeBlog = true } = {}) {
  const url = apiUrl(endpoint, includeBlog);
  const response = await fetch(url, {
    method,
    headers: {
      "X-Mc-Auth": process.env.METRICOOL_API_TOKEN,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(12 * 60 * 1000)
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { message: raw }; }
  if (!response.ok) {
    const detail = data?.message || data?.error || data?.detail || raw || ("HTTP " + response.status);
    const error = new Error("Metricool (" + response.status + ") : " + safeMessage(detail));
    error.status = response.status;
    throw error;
  }
  return data;
}

function deleteTicket(token) {
  const ticket = mediaTickets.get(token);
  if (!ticket) return;
  clearTimeout(ticket.timer);
  mediaTickets.delete(token);
  fs.promises.unlink(ticket.filePath).catch(() => {});
}

module.exports = function attachMetricoolRoutes(app, { requireAdmin, upload, pool }) {
  const config = metricoolConfig;
  const createTableSql = "CREATE TABLE IF NOT EXISTS metricool_publications (" +
    "id BIGSERIAL PRIMARY KEY, metricool_post_id TEXT, title TEXT NOT NULL, " +
    "description TEXT NOT NULL DEFAULT '', publish_at TIMESTAMPTZ NOT NULL, " +
    "created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), status TEXT NOT NULL DEFAULT 'scheduled')";

  app.get("/api/metricool/status", requireAdmin, (_req, res) => {
    const state = config();
    res.json({
      configured: state.configured,
      missing: state.missing,
      timezone: state.timezone,
      provider: "Metricool",
      blogId: process.env.METRICOOL_BLOG_ID || DEFAULT_METRICOOL_BLOG_ID,
      apiPlanRequired: "Advanced ou Custom",
      channelConnectionUrl: process.env.METRICOOL_CONNECTION_URL ||
        "https://app.metricool.com/brands/connections"
    });
  });

  app.get("/api/metricool/brands", requireAdmin, async (_req, res) => {
    if (!config().configured) return res.status(503).json({
      error: "Configurez les identifiants API Metricool dans Render.",
      missing: config().missing
    });
    try {
      const data = await metricoolRequest("/admin/simpleProfiles", { includeBlog: false });
      res.json({ ok: true, brands: data?.data || data });
    } catch (error) {
      res.status(error.status || 502).json({ error: error.message });
    }
  });

  app.get("/api/metricool/scheduled", requireAdmin, async (req, res) => {
    if (!config().configured) return res.status(503).json({
      error: "Configurez les identifiants API Metricool dans Render.",
      missing: config().missing
    });
    try {
      const now = new Date();
      const end = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000);
      const url = apiUrl("/v2/scheduler/posts");
      url.searchParams.set("start", String(req.query.start || now.toISOString()));
      url.searchParams.set("end", String(req.query.end || end.toISOString()));
      url.searchParams.set("timezone", config().timezone);
      const response = await fetch(url, {
        headers: { "X-Mc-Auth": process.env.METRICOOL_API_TOKEN },
        signal: AbortSignal.timeout(30000)
      });
      const raw = await response.text();
      let data;
      try { data = raw ? JSON.parse(raw) : {}; } catch (_) { data = { message: raw }; }
      if (!response.ok) throw new Error("Metricool (" + response.status + ") : " +
        safeMessage(data?.message || data?.error || raw));
      res.json({ ok: true, posts: data?.data || data });
    } catch (error) {
      res.status(502).json({ error: error.message });
    }
  });

  app.get("/api/metricool/history", requireAdmin, async (_req, res) => {
    if (!pool) return res.status(503).json({ error: "Base de données indisponible." });
    try {
      await pool.query(createTableSql);
      const result = await pool.query(
        "SELECT id, metricool_post_id, title, description, publish_at, created_at, status FROM metricool_publications ORDER BY created_at DESC LIMIT 100"
      );
      res.json({ publications: result.rows });
    } catch (error) {
      res.status(500).json({ error: "Lecture de l'historique Metricool impossible." });
    }
  });

  app.route("/_media/metricool/:token")
    .get(serveMedia)
    .head(serveMedia);

  function serveMedia(req, res) {
    const ticket = mediaTickets.get(String(req.params.token || ""));
    if (!ticket || ticket.expiresAt < Date.now() || !fs.existsSync(ticket.filePath)) {
      return res.status(404).end();
    }
    res.set({
      "Content-Type": ticket.mimeType,
      "Content-Length": String(ticket.size),
      "Content-Disposition": 'inline; filename="' + encodeURIComponent(ticket.fileName).replace(/"/g, "") + '"',
      "Cache-Control": "no-store",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") return res.status(200).end();
    const stream = fs.createReadStream(ticket.filePath);
    stream.on("error", () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
    stream.pipe(res);
  }

  app.post("/api/metricool/publish", requireAdmin, upload.single("video"), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "Sélectionnez une vidéo." });
    const cleanup = () => fs.promises.unlink(file.path).catch(() => {});
    let mediaToken = null;
    try {
      if (!config().configured) {
        await cleanup();
        return res.status(503).json({
          error: "L'API Metricool n'est pas encore configurée dans Render.",
          missing: config().missing
        });
      }
      if (req.body.rightsConfirmed !== "true") {
        await cleanup();
        return res.status(400).json({ error: "Confirmez que vous possédez les droits nécessaires pour redistribuer cette vidéo." });
      }
      const title = String(req.body.title || "").trim().slice(0, 100);
      const description = String(req.body.description || "").trim().slice(0, 5000);
      if (!title) {
        await cleanup();
        return res.status(400).json({ error: "Le titre est obligatoire." });
      }
      if (!["true", "false"].includes(String(req.body.madeForKids))) {
        await cleanup();
        return res.status(400).json({ error: "Précisez si la vidéo est conçue pour les enfants." });
      }
      const publishAt = req.body.publishAt ? new Date(req.body.publishAt) :
        new Date(Date.now() + 5 * 60 * 1000);
      if (!Number.isFinite(publishAt.getTime()) || publishAt.getTime() <= Date.now()) {
        await cleanup();
        return res.status(400).json({ error: "Choisissez une date et une heure futures." });
      }
      const videoType = String(req.body.youtubeType || "video") === "short" ? "short" : "video";
      const state = config();
      const token = crypto.randomBytes(32).toString("hex");
      mediaToken = token;
      const baseUrl = String(process.env.PUBLIC_BASE_URL ||
        (req.protocol + "://" + req.get("host"))).replace(/\/+$/, "");
      const ticket = {
        filePath: path.resolve(file.path),
        fileName: path.basename(file.originalname || "video.mp4"),
        mimeType: file.mimetype || "video/mp4",
        size: file.size,
        expiresAt: Date.now() + MEDIA_TTL_MS,
        timer: null
      };
      ticket.timer = setTimeout(() => deleteTicket(token), MEDIA_TTL_MS);
      mediaTickets.set(token, ticket);

      const payload = {
        publicationDate: {
          dateTime: localDateTime(publishAt, state.timezone),
          timezone: state.timezone
        },
        text: description,
        providers: [{ network: "youtube" }],
        media: [baseUrl + "/_media/metricool/" + token],
        saveExternalMediaFiles: true,
        autoPublish: true,
        youtubeData: {
          title,
          type: videoType,
          privacy: "public",
          madeForKids: req.body.madeForKids === "true"
        }
      };

      const result = await metricoolRequest("/v2/scheduler/posts", {
        method: "POST",
        body: payload
      });
      const post = result?.data || result;
      const postId = post?.id ?? post?.postId ?? post?.uuid ?? null;

      if (pool) {
        try {
          await pool.query(createTableSql);
          await pool.query(
            "INSERT INTO metricool_publications (metricool_post_id,title,description,publish_at,status) VALUES ($1,$2,$3,$4,$5)",
            [postId === null ? null : String(postId), title, description, publishAt.toISOString(), "scheduled"]
          );
        } catch (historyError) {
          console.error("Metricool history save:", historyError.message);
        }
      }
      deleteTicket(token);
      res.json({
        ok: true,
        provider: "Metricool",
        postId,
        title,
        publishAt: publishAt.toISOString(),
        message: "Vidéo transférée à Metricool et ajoutée au calendrier."
      });
    } catch (error) {
      console.error("Metricool publish:", error.message);
      if (mediaToken) deleteTicket(mediaToken);
      await cleanup();
      res.status(error.status || 502).json({
        error: "Metricool n'a pas accepté la programmation : " + safeMessage(error.message)
      });
    }
  });
};
