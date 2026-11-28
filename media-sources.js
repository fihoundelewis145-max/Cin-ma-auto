"use strict";

const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const MAX_BYTES = 1500 * 1024 * 1024;
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".webm", ".mpg", ".mpeg"]);
const ALLOWED_COMMONS_LICENSES = /^(?:public domain|cc0|cc by(?:-sa)? (?:3\.0|4\.0)(?: international)?)$/i;

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
}

function licenseFromArchive(metadata) {
  const licenseUrl = String(metadata.licenseurl || "").trim();
  const rights = cleanText(metadata.rights || "");
  const lowerUrl = licenseUrl.toLowerCase();
  const lowerRights = rights.toLowerCase();

  if (lowerRights.includes("non-commercial") || lowerRights.includes("noncommercial") ||
      lowerRights.includes("no derivatives") || lowerRights.includes("no-derivatives")) return null;

  if (lowerUrl.includes("creativecommons.org/publicdomain/zero/") ||
      /\bcc0\b/.test(lowerRights)) return { label: "CC0", url: licenseUrl || "https://creativecommons.org/publicdomain/zero/1.0/", autoEligible: true };

  if (lowerUrl.includes("creativecommons.org/licenses/by-sa/4.0") ||
      lowerUrl.includes("creativecommons.org/licenses/by-sa/3.0")) {
    return { label: "CC BY-SA", url: licenseUrl, autoEligible: false };
  }
  if (lowerUrl.includes("creativecommons.org/licenses/by/4.0") ||
      lowerUrl.includes("creativecommons.org/licenses/by/3.0")) {
    return { label: "CC BY", url: licenseUrl, autoEligible: false };
  }
  if (lowerUrl.includes("creativecommons.org/publicdomain/mark/") ||
      /\bpublic domain\b/.test(lowerRights)) {
    return { label: "Domaine public (déclaré par la fiche)", url: licenseUrl || "https://creativecommons.org/publicdomain/mark/1.0/", autoEligible: true };
  }
  return null;
}

function licenseFromCommons(ext) {
  const label = cleanText(ext?.LicenseShortName?.value);
  const url = cleanText(ext?.LicenseUrl?.value);
  if (!ALLOWED_COMMONS_LICENSES.test(label)) return null;
  if (/nc|nd|non.?commercial|no.?derivatives/i.test(label)) return null;
  return { label, url, autoEligible: /^(?:public domain|cc0)$/i.test(label) };
}

function safeFile(file) {
  const name = String(file?.name || "");
  const ext = path.extname(name).toLowerCase();
  const size = Number(file?.size || 0);
  return name && !name.includes("/") && !name.includes("\\") &&
    VIDEO_EXTENSIONS.has(ext) && size > 0 && size <= MAX_BYTES;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { "User-Agent": "CINEMA-AUTO/2.0 (open-media catalog integration)", ...headers },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) throw new Error("Source indisponible (" + response.status + ").");
  return response.json();
}

async function searchInternetArchive(query, limit = 8) {
  const q = String(query || "").trim().replace(/["\\]/g, " ").slice(0, 100);
  if (q.length < 2) return [];
  const searchUrl = new URL("https://archive.org/advancedsearch.php");
  searchUrl.searchParams.set("q", 'mediatype:movies AND title:("' + q + '")');
  for (const field of ["identifier", "title", "year", "description"]) searchUrl.searchParams.append("fl[]", field);
  searchUrl.searchParams.set("rows", String(Math.min(Math.max(limit, 1), 10)));
  searchUrl.searchParams.set("output", "json");
  const data = await fetchJson(searchUrl);
  const docs = data?.response?.docs || [];

  const results = await Promise.all(docs.map(async doc => {
    const identifier = String(doc.identifier || "");
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(identifier)) return null;
    try {
      const metadata = await fetchJson("https://archive.org/metadata/" + encodeURIComponent(identifier));
      const license = licenseFromArchive(metadata?.metadata || {});
      if (!license) return null;
      const files = (metadata.files || []).filter(safeFile).sort((a, b) => Number(b.size) - Number(a.size));
      const file = files[0];
      if (!file) return null;
      return {
        id: "ia:" + identifier + ":" + file.name,
        provider: "Internet Archive",
        providerKey: identifier,
        fileName: file.name,
        title: cleanText(doc.title || metadata.metadata?.title || identifier),
        year: String(doc.year || ""),
        description: cleanText(doc.description || metadata.metadata?.description || "").slice(0, 600),
        license: license.label,
        licenseUrl: license.url,
        attribution: cleanText(metadata.metadata?.creator || metadata.metadata?.publisher || ""),
        itemUrl: "https://archive.org/details/" + encodeURIComponent(identifier),
        sizeBytes: Number(file.size),
        format: path.extname(file.name).slice(1).toUpperCase(),
        autoEligible: license.autoEligible
      };
    } catch (_) {
      return null;
    }
  }));
  return results.filter(Boolean);
}

async function searchWikimediaCommons(query, limit = 8) {
  const q = String(query || "").trim().slice(0, 100);
  if (q.length < 2) return [];
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("format", "json");
  api.searchParams.set("generator", "search");
  api.searchParams.set("gsrnamespace", "6");
  api.searchParams.set("gsrsearch", q + " filetype:video");
  api.searchParams.set("gsrlimit", String(Math.min(Math.max(limit, 1), 10)));
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url|size|mime|extmetadata");
  const data = await fetchJson(api, { "Api-User-Agent": "CINEMA-AUTO/2.0 (contact: administrator)" });
  const pages = Object.values(data?.query?.pages || {});

  return pages.map(page => {
    const info = page.imageinfo?.[0];
    const title = String(page.title || "");
    const ext = path.extname(title).toLowerCase();
    const license = licenseFromCommons(info?.extmetadata || {});
    const size = Number(info?.size || 0);
    if (!info?.url || !license || ![".webm", ".mpg", ".mpeg"].includes(ext) || !size || size > MAX_BYTES) return null;
    const mediaUrl = new URL(info.url);
    if (mediaUrl.protocol !== "https:" || mediaUrl.hostname !== "upload.wikimedia.org") return null;
    const meta = info.extmetadata || {};
    return {
      id: "commons:" + title,
      provider: "Wikimedia Commons",
      providerKey: title,
      title: cleanText(title.replace(/^File:/, "").replace(/\.[^.]+$/, "")),
      year: "",
      description: cleanText(meta.ImageDescription?.value || "").slice(0, 600),
      license: license.label,
      licenseUrl: license.url,
      attribution: cleanText(meta.Artist?.value || ""),
      itemUrl: "https://commons.wikimedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")),
      sizeBytes: size,
      format: ext.slice(1).toUpperCase(),
      autoEligible: license.autoEligible
    };
  }).filter(Boolean);
}

async function searchOpenSources(query) {
  const settled = await Promise.allSettled([
    searchInternetArchive(query, 8),
    searchWikimediaCommons(query, 8)
  ]);
  const sources = settled.flatMap(result => result.status === "fulfilled" ? result.value : []);
  return {
    sources,
    providers: {
      internetArchive: settled[0].status === "fulfilled" ? "ok" : "indisponible",
      wikimediaCommons: settled[1].status === "fulfilled" ? "ok" : "indisponible"
    }
  };
}

async function getOpenVideoSource(provider, providerKey, fileName) {
  if (provider === "Internet Archive") {
    if (!/^[A-Za-z0-9_-]{3,80}$/.test(String(providerKey || ""))) throw new Error("Identifiant Internet Archive invalide.");
    const metadata = await fetchJson("https://archive.org/metadata/" + encodeURIComponent(providerKey));
    const license = licenseFromArchive(metadata?.metadata || {});
    if (!license) throw new Error("La licence Internet Archive n'est pas explicitement réutilisable. Import bloqué.");
    const file = (metadata.files || []).find(item => item.name === fileName && safeFile(item));
    if (!file) throw new Error("Le fichier vidéo n'est plus disponible ou dépasse la limite autorisée.");
    return {
      url: "https://archive.org/download/" + encodeURIComponent(providerKey) + "/" + encodeURIComponent(file.name),
      title: cleanText(metadata.metadata?.title || providerKey),
      description: cleanText(metadata.metadata?.description || "").slice(0, 3000),
      license,
      attribution: cleanText(metadata.metadata?.creator || metadata.metadata?.publisher || ""),
      itemUrl: "https://archive.org/details/" + encodeURIComponent(providerKey),
      size: Number(file.size),
      extension: path.extname(file.name).toLowerCase(),
      autoEligible: license.autoEligible
    };
  }

  if (provider === "Wikimedia Commons") {
    const title = String(providerKey || "");
    if (!/^File:[^/\\\\]{1,240}\.(?:webm|mpg|mpeg)$/i.test(title)) throw new Error("Nom de fichier Wikimedia Commons invalide.");
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.searchParams.set("action", "query");
    api.searchParams.set("format", "json");
    api.searchParams.set("titles", title);
    api.searchParams.set("prop", "imageinfo");
    api.searchParams.set("iiprop", "url|size|extmetadata");
    const data = await fetchJson(api, { "Api-User-Agent": "CINEMA-AUTO/2.0" });
    const page = Object.values(data?.query?.pages || {})[0];
    const info = page?.imageinfo?.[0];
    const license = licenseFromCommons(info?.extmetadata || {});
    if (!info?.url || !license) throw new Error("Licence Wikimedia absente ou non admise. Import bloqué.");
    const mediaUrl = new URL(info.url);
    if (mediaUrl.protocol !== "https:" || mediaUrl.hostname !== "upload.wikimedia.org") throw new Error("Hôte média Wikimedia non autorisé.");
    const size = Number(info.size || 0);
    if (!size || size > MAX_BYTES) throw new Error("Fichier vidéo trop volumineux ou taille inconnue.");
    return {
      url: mediaUrl.href,
      title: cleanText(title.replace(/^File:/, "").replace(/\.[^.]+$/, "")),
      description: cleanText(info.extmetadata?.ImageDescription?.value || "").slice(0, 3000),
      license,
      attribution: cleanText(info.extmetadata?.Artist?.value || ""),
      itemUrl: "https://commons.wikimedia.org/wiki/" + encodeURIComponent(title.replace(/ /g, "_")),
      size,
      extension: path.extname(title).toLowerCase(),
      autoEligible: license.autoEligible
    };
  }

  throw new Error("Cette source n'est pas prise en charge par l'import automatique.");
}

async function downloadOpenVideo(provider, providerKey, fileName, destination) {
  const source = await getOpenVideoSource(provider, providerKey, fileName);
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: { "User-Agent": "CINEMA-AUTO/2.0" },
    signal: AbortSignal.timeout(120000)
  });
  const finalUrl = new URL(response.url);
  const allowedHost = provider === "Internet Archive"
    ? finalUrl.hostname === "archive.org" || finalUrl.hostname.endsWith(".archive.org")
    : finalUrl.hostname === "upload.wikimedia.org";
  if (!allowedHost || finalUrl.protocol !== "https:" || !response.ok || !response.body) {
    throw new Error("Téléchargement refusé par l'hôte média ou fichier indisponible.");
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_BYTES || (source.size && source.size > MAX_BYTES)) throw new Error("Fichier supérieur à 1,5 Go.");
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
  const actualSize = fs.statSync(destination).size;
  if (!actualSize || actualSize > MAX_BYTES) {
    fs.unlinkSync(destination);
    throw new Error("Taille téléchargée invalide.");
  }
  return { ...source, size: actualSize };
}

module.exports = { searchOpenSources, downloadOpenVideo, MAX_BYTES };
