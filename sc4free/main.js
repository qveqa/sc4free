const { app, BrowserWindow, ipcMain, protocol, net, dialog, safeStorage, shell } = require('electron');

// Enable smooth scrolling natively in Chromium
app.commandLine.appendSwitch('enable-smooth-scrolling');

// Register custom media protocol as privileged to allow local file audio streaming & Range headers
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: {
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: false
    }
  }
]);

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const nodeId3 = require('node-id3');
const { pathToFileURL } = require('url');
const http = require('http');
const https = require('https');

// Configure global Axios agent defaults with keepAlive to speed up searches & metadata fetching
// SECURITY FIX: enforce timeouts, redirect limits and response size caps to prevent DoS/hang.
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });
axios.defaults.timeout = 15000;
axios.defaults.maxRedirects = 5;
axios.defaults.maxContentLength = 50 * 1024 * 1024; // 50 MB
axios.defaults.maxBodyLength = 10 * 1024 * 1024;

// Import SQLite Database Module
const db = require('./database.js');

// Point fluent-ffmpeg to the static binary provided by ffmpeg-static
ffmpeg.setFfmpegPath(ffmpegStatic);

let mainWindow;

// Strict Hostname Whitelist for URL requests
const ALLOWED_HOSTS = new Set([
  'soundcloud.com',
  'www.soundcloud.com',
  'api-v2.soundcloud.com',
  'cf-media.sndcdn.com',
  'playback.media-streaming.soundcloud.cloud',
  'a-v2.sndcdn.com',
  'a1.sndcdn.com'
]);

function validateUrl(targetUrl) {
  try {
    if (typeof targetUrl !== 'string' || !targetUrl.startsWith('https://')) return false;
    if (targetUrl.includes('\0') || targetUrl.length > 2048) return false;
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false; // block embedded credentials
    // Block non-default ports to reduce SSRF surface
    if (parsed.port && parsed.port !== '443') return false;
    const host = parsed.hostname.toLowerCase();
    if (!host || host.includes('\0')) return false;
    return ALLOWED_HOSTS.has(host) || 
           host.endsWith('.sndcdn.com') || 
           host.endsWith('.soundcloud.com') || 
           host.endsWith('.soundcloud.cloud');
  } catch (e) {
    return false;
  }
}

// SECURITY FIX: shared validation helpers to prevent path traversal,
// ID spoofing and IPC payload abuse.
const TRACK_ID_RE = /^\d{1,20}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9]{32}$/;
const TOKEN_RE = /^[A-Za-z0-9\-_]{10,300}$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function isValidTrackId(id) {
  return typeof id === 'string' || typeof id === 'number'
    ? TRACK_ID_RE.test(String(id))
    : false;
}

function isValidClientId(id) {
  return typeof id === 'string' && CLIENT_ID_RE.test(id);
}

function isValidTokenFormat(t) {
  return typeof t === 'string' && TOKEN_RE.test(t.trim());
}

// Returns true iff `child` resolves inside `parent` (prevents prefix bypass like music-evil).
function isPathInsideDir(child, parent) {
  try {
    const rel = path.relative(path.resolve(parent), path.resolve(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function safeJoinDownloadDir(downloadDir, fileName) {
  if (typeof fileName !== 'string' || fileName.includes('\0')) return null;
  // Reject absolute paths and traversal attempts early
  if (path.isAbsolute(fileName)) return null;
  const joined = path.normalize(path.join(downloadDir, fileName));
  if (!isPathInsideDir(joined, downloadDir) && path.resolve(joined) !== path.resolve(downloadDir)) return null;
  // Extra guard: fileName itself must not contain directory separators after sanitization
  const base = path.basename(joined);
  if (base !== path.basename(fileName) && fileName.includes('..')) return null;
  return joined;
}

function validateTranscodings(transcodings) {
  if (!Array.isArray(transcodings) || transcodings.length === 0 || transcodings.length > 10) return false;
  for (const t of transcodings) {
    if (!t || typeof t !== 'object') return false;
    if (!t.url || typeof t.url !== 'string' || !validateUrl(t.url)) return false;
    const proto = t?.format?.protocol;
    if (proto !== 'progressive' && proto !== 'hls') return false;
  }
  return true;
}

function sanitizeTrackMeta(input) {
  if (!input || typeof input !== 'object') return null;
  const trackId = String(input.trackId ?? input.id ?? '');
  if (!isValidTrackId(trackId)) return null;
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 300) : '';
  const artist = typeof input.artist === 'string' ? input.artist.trim().slice(0, 300) : '';
  if (!title || !artist) return null;
  const artworkUrl = input.artworkUrl ?? input.artwork_url ?? '';
  if (artworkUrl && (typeof artworkUrl !== 'string' || artworkUrl.length > 2048 || !validateUrl(artworkUrl))) return null;
  if (!validateTranscodings(input.transcodings)) return null;
  const duration = Number(input.duration || 0);
  if (!Number.isFinite(duration) || duration < 0 || duration > 10 * 3600 * 1000) return null;
  return { trackId, title, artist, artworkUrl: artworkUrl || '', transcodings: input.transcodings, duration };
}

function isSafeDownloadDir(dir) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    const norm = path.normalize(dir);
    if (norm.includes('\0')) return false;
    // Block filesystem roots and OS-sensitive locations
    const lower = process.platform === 'win32' ? norm.toLowerCase() : norm;
    const blockedExact = process.platform === 'win32'
      ? ['c:\\', 'c:/', 'c:', 'd:\\', 'd:/']
      : ['/', '/root', '/etc', '/bin', '/sbin', '/usr', '/boot', '/sys', '/proc'];
    if (blockedExact.includes(lower)) return false;
    const blockedSub = process.platform === 'win32'
      ? ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\system', 'c:/windows']
      : ['/etc/', '/bin/', '/sbin/', '/usr/bin', '/boot/', '/sys/', '/proc/'];
    if (blockedSub.some(p => process.platform === 'win32' ? lower.startsWith(p) : norm.startsWith(p))) return false;
    return true;
  } catch {
    return false;
  }
}

// ----------------------------------------------------
// Settings Loading & Saving (using SQLite)
// ----------------------------------------------------
let settings = {
  settings_version: 1,
  downloadDirectory: path.join(__dirname, 'output'),
  volume: 0.8,
  repeatMode: 'none', // 'none' | 'one' | 'all'
  shuffleMode: false,
  windowWidth: 1100,
  windowHeight: 750
};

function loadSettingsFromDB() {
  const defaultDir = path.join(__dirname, 'output');
  if (!fs.existsSync(defaultDir)) {
    try {
      fs.mkdirSync(defaultDir, { recursive: true });
    } catch (err) {
      console.error('Failed to create default output directory:', err);
    }
  }

  settings.settings_version = db.getSetting('settings_version', 1);
  
  let savedDir = db.getSetting('downloadDirectory', defaultDir);
  // Migrate from old Music defaults to new sc4free/output directory
  if (!savedDir || savedDir.includes('SoundCloudOffline') || savedDir.includes('music') || savedDir.includes('Music')) {
    savedDir = defaultDir;
    db.setSetting('downloadDirectory', defaultDir);
  }

  settings.downloadDirectory = savedDir;
  const vol = db.getSetting('volume', 0.8);
  settings.volume = (typeof vol === 'number' && vol >= 0 && vol <= 1) ? vol : 0.8;
  const rm = db.getSetting('repeatMode', 'none');
  settings.repeatMode = ['none', 'one', 'all'].includes(rm) ? rm : 'none';
  settings.shuffleMode = !!db.getSetting('shuffleMode', false);
  const ww = db.getSetting('windowWidth', 1100);
  const wh = db.getSetting('windowHeight', 750);
  settings.windowWidth = (Number.isInteger(ww) && ww >= 600 && ww <= 3840) ? ww : 1100;
  settings.windowHeight = (Number.isInteger(wh) && wh >= 400 && wh <= 2160) ? wh : 750;
  // SECURITY FIX: validate persisted download dir on load; reset to default if unsafe
  if (!isSafeDownloadDir(settings.downloadDirectory)) {
    settings.downloadDirectory = defaultDir;
    try { db.setSetting('downloadDirectory', defaultDir); } catch (_) {}
  }
}

function saveSettingToDB(key, value) {
  db.setSetting(key, value);
}

// SECURITY FIX: allowlist for renderer-controlled settings.
// downloadDirectory may only be changed via select-download-dir dialog.
const SETTINGS_ALLOWLIST = new Set(['volume', 'repeatMode', 'shuffleMode', 'windowWidth', 'windowHeight']);
function sanitizeSettingsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return {};
  const out = {};
  if ('volume' in patch) {
    const v = Number(patch.volume);
    if (Number.isFinite(v) && v >= 0 && v <= 1) out.volume = v;
  }
  if ('repeatMode' in patch) {
    if (['none', 'one', 'all'].includes(patch.repeatMode)) out.repeatMode = patch.repeatMode;
  }
  if ('shuffleMode' in patch) {
    if (typeof patch.shuffleMode === 'boolean') out.shuffleMode = patch.shuffleMode;
  }
  if ('windowWidth' in patch) {
    const w = Number(patch.windowWidth);
    if (Number.isInteger(w) && w >= 600 && w <= 3840) out.windowWidth = w;
  }
  if ('windowHeight' in patch) {
    const h = Number(patch.windowHeight);
    if (Number.isInteger(h) && h >= 400 && h <= 2160) out.windowHeight = h;
  }
  return out;
}

// ----------------------------------------------------
// Secure Token Management (using safeStorage)
// ----------------------------------------------------
// In-memory fallback when OS keychain is unavailable — never persist plaintext.
let inMemoryToken = null;
function saveOauthToken(token) {
  if (!token || typeof token !== 'string') return;
  const clean = token.trim();
  if (!isValidTokenFormat(clean)) {
    console.warn('Refused to store token with invalid format.');
    return;
  }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(clean);
      db.saveToken('oauth_token', encrypted);
      inMemoryToken = null;
      console.log('oauth_token encrypted and stored securely.');
    } else {
      // SECURITY FIX: do not write plaintext to disk. Keep only in memory.
      inMemoryToken = clean;
      try { db.deleteToken('oauth_token'); } catch (_) {}
      console.warn('safeStorage not available. Token kept in memory only (not persisted).');
    }
  } catch (e) {
    console.error('Failed to encrypt/save token:', e);
  }
}

function getOauthToken() {
  try {
    const buffer = db.getToken('oauth_token');
    if (buffer) {
      if (safeStorage.isEncryptionAvailable()) {
        const dec = safeStorage.decryptString(buffer);
        return isValidTokenFormat(dec) ? dec : null;
      } else {
        // Plaintext on disk from old versions: migrate to memory and wipe.
        const plain = buffer.toString('utf8');
        if (isValidTokenFormat(plain)) inMemoryToken = plain.trim();
        try { db.deleteToken('oauth_token'); } catch (_) {}
        return inMemoryToken;
      }
    }
    return inMemoryToken;
  } catch (e) {
    console.error('Failed to decrypt token:', e);
    return inMemoryToken || null;
  }
}

// Fetch user profile via SoundCloud API /me
async function fetchUserProfile(token) {
  try {
    if (!isValidTokenFormat(token)) return null;
    const clientId = await getClientId();
    if (!isValidClientId(clientId)) throw new Error('Invalid client_id.');
    const url = `https://api-v2.soundcloud.com/me?client_id=${clientId}`;
    
    // Strict URL check
    if (!validateUrl(url)) throw new Error('Unsafe URL blocked.');

    const res = await axios.get(url, {
      headers: {
        'Authorization': `OAuth ${token.trim()}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 8000,
      maxContentLength: 2 * 1024 * 1024
    });
    return res.data;
  } catch (e) {
    console.error('Failed to fetch user profile:', e.message);
    return null;
  }
}

// ----------------------------------------------------
// SoundCloud Client ID Scraper & Cache
// ----------------------------------------------------
let activeClientId = null;
let cachePath = null; // initialized after app ready
const searchCache = new Map();
const SEARCH_CACHE_TTL = 5 * 60 * 1000;

async function getClientId() {
  if (activeClientId && isValidClientId(activeClientId)) return activeClientId;
  activeClientId = null;

  // Try loading from cache
  let cached = null;
  try {
    if (cachePath && fs.existsSync(cachePath)) {
      const raw = fs.readFileSync(cachePath, 'utf8');
      if (raw.length > 1024) throw new Error('client-id cache too large');
      cached = JSON.parse(raw);
      if (!cached || !isValidClientId(cached.clientId)) throw new Error('invalid cached client_id format');
      if (typeof cached.validatedAt !== 'number') throw new Error('invalid cache timestamp');
      const oneDay = 24 * 60 * 60 * 1000;
      if (cached.validatedAt && (Date.now() - cached.validatedAt < 3 * oneDay)) {
        // Cache is young, trust it without validating to make first search/action instant
        console.log('Using cached client_id without validation.');
        activeClientId = cached.clientId;
        return activeClientId;
      } else if (cached.validatedAt && (Date.now() - cached.validatedAt < 7 * oneDay)) {
        const isValid = await validateClientId(cached.clientId);
        if (isValid) {
          console.log('Using cached client_id.');
          activeClientId = cached.clientId;
          return activeClientId;
        }
      }
    }
  } catch (e) {
    console.warn('Failed to load/validate client ID cache:', e.message);
  }

  // Scrape a new client ID
  console.log('Scraping new client_id...');
  const newId = await scrapeClientId();
  if (newId && isValidClientId(newId)) {
    activeClientId = newId;
    try {
      if (cachePath) {
        fs.writeFileSync(cachePath, JSON.stringify({
          clientId: newId,
          validatedAt: Date.now()
        }, null, 2), { encoding: 'utf8', mode: 0o600 });
      }
    } catch (e) {
      console.error('Failed to save client_id cache:', e);
    }
    return newId;
  }

  const fallback = 'iZ6gthvODSYgDRB5wo1cm51LSbs0uqO2';
  console.log('Scraping failed, using fallback client_id.');
  activeClientId = fallback;
  return fallback;
}

async function validateClientId(id) {
  try {
    if (!isValidClientId(id)) return false;
    const url = `https://api-v2.soundcloud.com/search/tracks?q=chill&client_id=${id}&limit=1`;
    if (!validateUrl(url)) return false;
    const res = await axios.get(url, { timeout: 5000, maxContentLength: 2 * 1024 * 1024 });
    return res.status === 200;
  } catch (e) {
    return false;
  }
}

async function scrapeClientId() {
  try {
    if (!validateUrl('https://soundcloud.com/')) return null;
    const res = await axios.get('https://soundcloud.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000,
      maxContentLength: 5 * 1024 * 1024
    });
    const html = typeof res.data === 'string' ? res.data : '';
    if (html.length > 5 * 1024 * 1024) return null;

    const scriptRegex = /<script[^>]+src=["'](https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js)["']/g;
    let match;
    const scriptUrls = [];
    while ((match = scriptRegex.exec(html)) !== null) {
      scriptUrls.push(match[1]);
      if (scriptUrls.length > 20) break;
    }
    scriptUrls.reverse();

    for (const url of scriptUrls) {
      try {
        if (!validateUrl(url)) continue; // Whitelist check on scripts
        const jsRes = await axios.get(url, { timeout: 5000, maxContentLength: 5 * 1024 * 1024, responseType: 'text' });
        const js = typeof jsRes.data === 'string' ? jsRes.data : '';
        const idMatch = js.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
        if (idMatch && idMatch[1] && isValidClientId(idMatch[1])) {
          console.log('Found client_id.');
          return idMatch[1];
        }
      } catch (err) {}
    }
  } catch (e) {
    console.error('Error during client_id scraping:', e.message);
  }
  return null;
}

// ----------------------------------------------------
// Safe Media File Custom Protocol
// ----------------------------------------------------
function registerMediaProtocol() {
  protocol.handle('media', (request) => {
    try {
      // Check if URL starts with media://path/
      if (!request.url.startsWith('media://path/')) {
        return new Response('Access Denied', { status: 403 });
      }

      const rawPath = request.url.slice('media://path/'.length);
      if (rawPath.includes('\0') || rawPath.length > 4096) {
        return new Response('Access Denied', { status: 403 });
      }
      let decodedPath;
      try {
        decodedPath = decodeURIComponent(rawPath);
      } catch {
        return new Response('Access Denied', { status: 403 });
      }
      // SECURITY FIX: reject double-encoding / null bytes / traversal tricks
      if (decodedPath.includes('\0') || decodedPath.includes('%')) {
        // Allow literal % in filenames but block encoded traversal after decode
        if (/%2e|%2f|%5c/i.test(rawPath) && /(\.\.[/\\])/.test(decodedPath)) {
          return new Response('Access Denied', { status: 403 });
        }
      }
      
      const filePath = process.platform === 'win32' && decodedPath.startsWith('/')
        ? decodedPath.slice(1)
        : decodedPath;

      // SECURITY FIX: use path.relative to prevent prefix bypass (e.g. music-evil).
      const normalizedFile = path.normalize(filePath);
      if (!isPathInsideDir(normalizedFile, settings.downloadDirectory)) {
        console.warn('Blocked unauthorized local file access.');
        return new Response('Access Denied', { status: 403 });
      }

      // Pass the original request headers to net.fetch to preserve Range headers for audio streaming
      return net.fetch(pathToFileURL(normalizedFile).toString(), {
        headers: request.headers
      });
    } catch (e) {
      console.error('Failed to handle media protocol:', e);
      return new Response('File not found', { status: 404 });
    }
  });
}

// ----------------------------------------------------
// Crash Recovery: Clean Isolated Temp Folder
// ----------------------------------------------------
function cleanTempDirectory() {
  if (!isSafeDownloadDir(settings.downloadDirectory)) return;
  const tempDir = path.join(settings.downloadDirectory, '.temp');
  try {
    if (fs.existsSync(tempDir)) {
      if (!isPathInsideDir(tempDir, settings.downloadDirectory)) return;
      console.log('Cleaning up isolated temporary downloads directory on startup...');
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (e) {
    console.error('Failed to clear temp directory:', e);
  }
}

// Helper to sanitize file names (strictly blocks path traversal and injection chars)
function sanitizeFilename(name) {
  if (typeof name !== 'string') return 'untitled';
  // Remove control chars and strip forbidden filesystem characters
  let safe = name.replace(/[\x00-\x1F\x7F]/g, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  // Strip trailing dots/spaces (Windows) and leading dots (hidden files)
  safe = safe.replace(/[. ]+$/g, '').replace(/^\.+/g, '_');
  if (!safe) return 'untitled';
  // Block Windows reserved device names
  const base = safe.split('.')[0];
  if (WINDOWS_RESERVED_RE.test(base)) safe = '_' + safe;
  // Limit to 100 chars to stay well within Windows MAX_PATH limits (artist + title + ext)
  return safe.slice(0, 100) || 'untitled';
}

// ----------------------------------------------------
// Download Queue & Processing (Max 2 Concurrency)
// ----------------------------------------------------
const memoryQueue = [];
let activeDownloadsCount = 0;
const MAX_CONCURRENT_DOWNLOADS = 4;
const downloadProgressThrottle = new Map(); // trackId -> last update timestamp
const PROGRESS_THROTTLE_MS = 250;

// Map of active downloads: trackId -> { abortController, ffmpegCmd }
const activeDownloadControllers = new Map();

function checkQueue() {
  if (activeDownloadsCount >= MAX_CONCURRENT_DOWNLOADS || memoryQueue.length === 0) return;

  const item = memoryQueue.shift();
  activeDownloadsCount++;
  processDownload(item);
}

async function processDownload(item) {
  // SECURITY FIX: validate all renderer-supplied fields; reject path traversal via trackId.
  const meta = sanitizeTrackMeta(item);
  if (!meta) {
    console.warn('Rejected download with invalid metadata.');
    return;
  }
  const { trackId, title, artist, artworkUrl, transcodings } = meta;
  const durationSafe = meta.duration;

  // Create an AbortController for this download
  const abortController = new AbortController();
  activeDownloadControllers.set(trackId, { abortController, ffmpegCmd: null });
  
  // Safe sanitizations
  const safeArtist = sanitizeFilename(artist);
  const safeTitle = sanitizeFilename(title);
  const baseName = `${safeArtist} - ${safeTitle}`;
  const outDir = settings.downloadDirectory;
  if (!isSafeDownloadDir(outDir)) {
    console.error('Unsafe download directory, aborting download.');
    activeDownloadControllers.delete(trackId);
    activeDownloadsCount--;
    return;
  }
  const tempDir = path.join(outDir, '.temp');
  
  const mp3Path = safeJoinDownloadDir(outDir, `${baseName}.mp3`);
  const jpgPath = safeJoinDownloadDir(outDir, `${baseName}.jpg`);
  const tmpMp3Path = path.join(tempDir, `${trackId}.tmp.mp3`);
  const tmpJpgPath = path.join(tempDir, `${trackId}.tmp.jpg`);
  // SECURITY FIX: tmp paths must stay inside tempDir (trackId is numeric, but double-check)
  if (!mp3Path || !jpgPath || !isPathInsideDir(tmpMp3Path, tempDir) || !isPathInsideDir(tmpJpgPath, tempDir)) {
    console.warn('Blocked download path escape attempt.');
    activeDownloadControllers.delete(trackId);
    activeDownloadsCount--;
    return;
  }

  const updateStatus = (status, progress = 0, error = null) => {
    db.saveDownloadTask({
      id: trackId,
      title,
      artist,
      artwork_url: artworkUrl,
      transcodings,
      status,
      progress,
      error
    });

    // Throttle IPC sends during active streaming to reduce UI load
    const isTerminal = status === 'completed' || status === 'failed' || status === 'tagging';
    const now = Date.now();
    const last = downloadProgressThrottle.get(trackId) || 0;
    if (!isTerminal && (now - last) < PROGRESS_THROTTLE_MS) return;
    downloadProgressThrottle.set(trackId, now);

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', {
        trackId, status, progress, error, title, artist
      });
    }
  };

  try {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Step 1: Download Cover Art (capped to prevent OOM/disk abuse)
    updateStatus('downloading', 5);
    let coverBuffer = null;
    if (artworkUrl) {
      try {
        if (!validateUrl(artworkUrl)) throw new Error('Cover art URL not whitelisted.');
        const coverRes = await axios.get(artworkUrl, {
          responseType: 'arraybuffer',
          timeout: 8000,
          maxContentLength: 10 * 1024 * 1024,
          maxBodyLength: 10 * 1024 * 1024
        });
        const ct = (coverRes.headers?.['content-type'] || '').toLowerCase();
        if (ct && !ct.startsWith('image/') && !ct.startsWith('application/octet-stream')) {
          throw new Error('Unexpected cover content-type.');
        }
        coverBuffer = Buffer.from(coverRes.data);
        if (coverBuffer.length > 10 * 1024 * 1024) throw new Error('Cover art too large.');
        fs.writeFileSync(tmpJpgPath, coverBuffer);
      } catch (err) {
        console.warn('Failed to download cover art:', err.message);
        coverBuffer = null;
      }
    }

    // Step 2: Resolve stream URL
    updateStatus('downloading', 15);
    const clientId = await getClientId();
    if (!isValidClientId(clientId)) throw new Error('Invalid client_id.');
    
    // Choose progressive MP3 transcoding if available, otherwise HLS
    let selectedTranscoding = transcodings.find(t => t.format.protocol === 'progressive');
    let isHls = false;
    
    if (!selectedTranscoding) {
      selectedTranscoding = transcodings.find(t => t.format.protocol === 'hls');
      isHls = true;
    }

    if (!selectedTranscoding) {
      throw new Error('No compatible progressive or HLS audio transcoding found.');
    }

    const streamMetaUrl = `${selectedTranscoding.url}?client_id=${clientId}`;
    if (!validateUrl(streamMetaUrl)) throw new Error('Resolved stream metadata URL not whitelisted.');

    const streamMetaRes = await axios.get(streamMetaUrl, { timeout: 10000, maxContentLength: 2 * 1024 * 1024 });
    const directStreamUrl = streamMetaRes.data?.url;

    if (typeof directStreamUrl !== 'string' || !validateUrl(directStreamUrl)) {
      throw new Error('Could not resolve secure streaming CDN URL.');
    }

    // Step 3: Download & Transcode Audio
    updateStatus('downloading', 25);

    if (isHls) {
      // HLS download using ffmpeg (spawned directly, protecting against shell injections)
      // SECURITY FIX: restrict protocols to prevent SSRF via m3u8 segments (no file://).
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(directStreamUrl)
          .inputOptions([
            '-http_persistent 1',
            '-threads 4',
            '-rw_timeout 15000000',
            '-protocol_whitelist http,https,tcp,tls,crypto'
          ])
          .outputOptions('-c copy')
          .format('mp3')
          .output(tmpMp3Path)
          .on('start', () => {
            updateStatus('transcoding', 40);
          })
          .on('progress', (progressInfo) => {
            const p = progressInfo.percent ? Math.min(80, 40 + Math.round(progressInfo.percent * 0.4)) : 60;
            updateStatus('transcoding', p);
          })
          .on('end', resolve)
          .on('error', (err) => {
            reject(err);
          });

        // Store reference for potential cancellation
        const entry = activeDownloadControllers.get(trackId);
        if (entry) entry.ffmpegCmd = cmd;

        cmd.run();

        // If already cancelled before ffmpeg started, kill immediately
        abortController.signal.addEventListener('abort', () => {
          try { cmd.kill('SIGKILL'); } catch (_) {}
          reject(new Error('CANCELLED'));
        });
        // Watchdog: kill HLS after 10 minutes to avoid hung ffmpeg
        setTimeout(() => {
          try { cmd.kill('SIGKILL'); } catch (_) {}
        }, 10 * 60 * 1000).unref?.();
      });
    } else {
      // Progressive MP3 download via axios stream (capped at 250 MB)
      const MAX_AUDIO_BYTES = 250 * 1024 * 1024;
      const writer = fs.createWriteStream(tmpMp3Path, { highWaterMark: 1024 * 1024 });
      const streamRes = await axios({
        url: directStreamUrl,
        method: 'GET',
        responseType: 'stream',
        signal: abortController.signal,
        timeout: 30000,
        maxContentLength: MAX_AUDIO_BYTES,
        maxBodyLength: MAX_AUDIO_BYTES
      });

      const totalLength = parseInt(streamRes.headers['content-length'] || '0', 10);
      if (Number.isFinite(totalLength) && totalLength > MAX_AUDIO_BYTES) {
        try { streamRes.data.destroy(); } catch (_) {}
        try { writer.destroy(); } catch (_) {}
        throw new Error('Audio file too large.');
      }
      let downloadedLength = 0;
      let abortedOversize = false;

      streamRes.data.on('data', (chunk) => {
        downloadedLength += chunk.length;
        if (downloadedLength > MAX_AUDIO_BYTES && !abortedOversize) {
          abortedOversize = true;
          try { streamRes.data.destroy(new Error('Audio file too large.')); } catch (_) {}
          try { writer.destroy(); } catch (_) {}
          return;
        }
        if (totalLength > 0) {
          const progress = Math.min(80, 25 + Math.round((downloadedLength / totalLength) * 55));
          updateStatus('downloading', progress);
        }
      });

      streamRes.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', () => abortedOversize ? reject(new Error('Audio file too large.')) : resolve());
        writer.on('error', (err) => {
          writer.destroy();
          reject(err);
        });
        streamRes.data.on('error', reject);
      });
    }

    // Check if cancelled between steps
    if (abortController.signal.aborted) throw new Error('CANCELLED');

    // Step 4: File Integrity Verification (Size must be 100KB..250MB)
    if (!fs.existsSync(tmpMp3Path)) {
      throw new Error('Downloaded temporary file not found on disk.');
    }
    const fileSize = fs.statSync(tmpMp3Path).size;
    if (fileSize < 100 * 1024) {
      throw new Error(`File integrity check failed: downloaded file size (${Math.round(fileSize/1024)} KB) is too small.`);
    }
    if (fileSize > 250 * 1024 * 1024) {
      throw new Error('File integrity check failed: file too large.');
    }

    // Step 5: Tag Metadata (Title, Artist, Album, Cover Art)
    updateStatus('tagging', 85);
    // SECURITY FIX: truncate ID3 fields to prevent tag-overflow / injection.
    const tags = {
      title: String(title).slice(0, 300),
      artist: String(artist).slice(0, 300),
      album: 'SoundCloud',
    };

    if (coverBuffer) {
      tags.image = {
        mime: 'image/jpeg',
        type: { id: 3, name: 'front cover' },
        description: 'Cover Art',
        imageBuffer: coverBuffer
      };
    }

    const success = nodeId3.write(tags, tmpMp3Path);
    if (!success) {
      console.warn('Failed to write ID3 tags, creating file without metadata.');
    }

    // Move cover and audio to final directory
    if (coverBuffer) {
      if (fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);
      try {
        fs.renameSync(tmpJpgPath, jpgPath);
      } catch (renameErr) {
        if (renameErr.code === 'EXDEV') {
          fs.copyFileSync(tmpJpgPath, jpgPath);
          fs.unlinkSync(tmpJpgPath);
        } else {
          throw renameErr;
        }
      }
    }
    
    if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
    try {
      fs.renameSync(tmpMp3Path, mp3Path);
    } catch (renameErr) {
      if (renameErr.code === 'EXDEV') {
        fs.copyFileSync(tmpMp3Path, mp3Path);
        fs.unlinkSync(tmpMp3Path);
      } else {
        throw renameErr;
      }
    }

    // Save success record to tracks database
    db.addTrack({
      id: trackId,
      title: String(title).slice(0, 300),
      artist: String(artist).slice(0, 300),
      fileName: `${baseName}.mp3`,
      coverName: coverBuffer ? `${baseName}.jpg` : null,
      duration: durationSafe || 0,
      downloadedAt: Date.now()
    });

    // Notify UI
    updateStatus('completed', 100);

    // Delete task from DB upon completion
    db.deleteDownloadTask(trackId);

  } catch (err) {
    if (err.message === 'CANCELLED' || err.code === 'ERR_CANCELED') {
      console.log(`Download cancelled for track ${trackId}`);
      updateStatus('cancelled', 0, 'Отменено пользователем');
    } else {
      console.error(`Download failed for track ${trackId}:`, err.message);
      updateStatus('failed', 0, err.message || 'Unknown download error');
    }
    
    // Clean up temporary workspace files
    if (fs.existsSync(tmpMp3Path)) {
      try { fs.unlinkSync(tmpMp3Path); } catch (_) {}
    }
    if (fs.existsSync(tmpJpgPath)) {
      try { fs.unlinkSync(tmpJpgPath); } catch (_) {}
    }
  } finally {
    downloadProgressThrottle.delete(trackId);
    activeDownloadControllers.delete(trackId);
    activeDownloadsCount--;
    checkQueue();
  }
}

// ----------------------------------------------------
// BrowserWindow Setup & Security
// ----------------------------------------------------
function createWindow() {
  // Initialize Database before app UI opens
  db.initDatabase(app);
  loadSettingsFromDB();
  cleanTempDirectory();

  mainWindow = new BrowserWindow({
    width: settings.windowWidth,
    height: settings.windowHeight,
    minWidth: 900,
    minHeight: 650,
    backgroundColor: '#000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: true, // Secure Same-Origin Policy
      contextIsolation: true, // Froze bridge isolation
      nodeIntegration: false, // Prevent direct shell exploits
      sandbox: true, // Run renderer inside isolated sandbox
      webviewTag: false,
      allowRunningInsecureContent: false,
      experimentalFeatures: false
    }
  });

  // SECURITY FIX: deny all permission requests (mic/camera/geolocation/etc.)
  try {
    const ses = mainWindow.webContents.session;
    ses.setPermissionRequestHandler((webContents, permission, callback) => callback(false));
    // Block attachment of webviews
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  } catch (_) {}

  mainWindow.setMenuBarVisibility(false);

  // Load UI
  if (app.isPackaged || process.env.NODE_ENV === 'production') {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  } else {
    mainWindow.loadURL('http://127.0.0.1:5173');
    // mainWindow.webContents.openDevTools(); // Uncomment for debugging
  }

  // Diagnostics: Log load failures
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`[Electron Error] Failed to load URL: ${validatedURL}`);
    console.error(`[Electron Error] Error Code: ${errorCode} (${errorDescription})`);
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  let resizeDebounceTimer = null;
  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    settings.windowWidth = width;
    settings.windowHeight = height;
    if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      saveSettingToDB('windowWidth', width);
      saveSettingToDB('windowHeight', height);
    }, 500);
  });

  // Security: Block any unverified navigations
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    // Only allow navigating to local index during development/release
    if (!navigationUrl.startsWith('file://') && 
        !navigationUrl.startsWith('http://localhost:5173') && 
        !navigationUrl.startsWith('http://127.0.0.1:5173')) {
      event.preventDefault();
      console.warn(`Blocked unauthorized navigation attempt to: ${navigationUrl}`);
    }
  });

  // Security: Deny window creation actions
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });
}

// ----------------------------------------------------
// App Lifecycle
// ----------------------------------------------------
app.whenReady().then(() => {
  registerMediaProtocol();
  cachePath = path.join(app.getPath('userData'), 'client-id-cache.json');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ----------------------------------------------------
// IPC Event Handlers (Request Proxies & Auth Actions)
// ----------------------------------------------------

// Settings
ipcMain.handle('get-settings', () => {
  return settings;
});

ipcMain.handle('save-settings', (event, newSettings) => {
  // SECURITY FIX: allowlist + range validation; downloadDirectory cannot be set here.
  const clean = sanitizeSettingsPatch(newSettings);
  settings = { ...settings, ...clean };
  for (const [key, val] of Object.entries(clean)) {
    saveSettingToDB(key, val);
  }
  return settings;
});

ipcMain.handle('select-download-dir', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    defaultPath: settings.downloadDirectory
  });
  if (!result.canceled && result.filePaths.length > 0) {
    const newDir = result.filePaths[0];
    // SECURITY FIX: validate dialog result before accepting.
    if (!isSafeDownloadDir(newDir)) {
      console.warn('Rejected unsafe download directory selection.');
      return null;
    }
    try {
      fs.mkdirSync(path.join(newDir, '.temp'), { recursive: true });
    } catch (e) {
      console.error('Download dir not writable:', e.message);
      return null;
    }
    settings.downloadDirectory = path.normalize(newDir);
    saveSettingToDB('downloadDirectory', settings.downloadDirectory);
    cleanTempDirectory(); // setup temp folder inside the new path
    return settings.downloadDirectory;
  }
  return null;
});

// Open URL in system browser
ipcMain.handle('open-external', (event, url) => {
  // SECURITY FIX: strict URL parsing instead of startsWith (prevents github.com/qveqa.evil bypass).
  try {
    if (typeof url !== 'string' || url.length > 512) return;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return;
    if (parsed.hostname.toLowerCase() !== 'github.com') return;
    const p = parsed.pathname;
    if (!(p === '/qveqa' || p.startsWith('/qveqa/'))) return;
    shell.openExternal(parsed.toString());
  } catch (_) {}
});

// Search playlists
ipcMain.handle('search-playlists', async (event, query) => {
  try {
    if (typeof query !== 'string') throw new Error('Invalid query.');
    const q = query.trim().slice(0, 200);
    if (!q) throw new Error('Empty query.');
    const clientId = await getClientId();
    if (!isValidClientId(clientId)) throw new Error('Invalid client_id.');
    const url = `https://api-v2.soundcloud.com/search/playlists?q=${encodeURIComponent(q)}&client_id=${clientId}&limit=16`;
    if (!validateUrl(url)) throw new Error('Playlist search URL not allowed.');

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    const token = getOauthToken();
    if (token) headers['Authorization'] = `OAuth ${token}`;

    const res = await axios.get(url, { headers, timeout: 10000, maxContentLength: 5 * 1024 * 1024 });
    return res.data;
  } catch (err) {
    console.error('Playlist search failed:', err.message);
    throw new Error(err.response?.data?.message || err.message);
  }
});

// Get single playlist with tracks
ipcMain.handle('get-playlist', async (event, playlistId) => {
  try {
    // Validate playlistId is numeric
    if (!/^\d{1,20}$/.test(String(playlistId))) throw new Error('Invalid playlist ID.');

    const clientId = await getClientId();
    if (!isValidClientId(clientId)) throw new Error('Invalid client_id.');
    const url = `https://api-v2.soundcloud.com/playlists/${encodeURIComponent(String(playlistId))}?client_id=${clientId}`;
    if (!validateUrl(url)) throw new Error('Playlist URL not allowed.');

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    const token = getOauthToken();
    if (token) headers['Authorization'] = `OAuth ${token}`;

    const res = await axios.get(url, { headers, timeout: 15000, maxContentLength: 10 * 1024 * 1024 });
    return res.data;
  } catch (err) {
    console.error('Get playlist failed:', err.message);
    if (err.response?.status === 401 || err.response?.status === 403) {
      activeClientId = null;
      try { if (cachePath) fs.unlinkSync(cachePath); } catch (_) {}
    }
    throw new Error(err.response?.data?.message || err.message);
  }
});

// ----------------------------------------------------
// User-created Playlists (local SQLite)
// ----------------------------------------------------

// Enrich a stored playlist track with offline file paths so the renderer can
// play it from disk when downloaded, or stream it otherwise.
function buildPlayableUserTrack(t) {
  let filePath = null;
  let coverPath = null;
  if (!t || !isValidTrackId(t.trackId)) return null;
  const downloaded = db.getTrackById(String(t.trackId));
  if (downloaded) {
    const fp = safeJoinDownloadDir(settings.downloadDirectory, downloaded.fileName);
    if (fp && fs.existsSync(fp)) {
      filePath = fp;
      if (downloaded.coverName) {
        const cp = safeJoinDownloadDir(settings.downloadDirectory, downloaded.coverName);
        if (cp && fs.existsSync(cp)) coverPath = cp;
      }
    }
  }
  return {
    id: String(t.trackId),
    trackId: String(t.trackId),
    title: String(t.title || '').slice(0, 300),
    artist: String(t.artist || '').slice(0, 300),
    duration: Number(t.duration) || 0,
    artwork_url: (typeof t.artworkUrl === 'string' && validateUrl(t.artworkUrl)) ? t.artworkUrl : null,
    media: { transcodings: Array.isArray(t.transcodings) ? t.transcodings.filter(x => x && typeof x.url === 'string' && validateUrl(x.url)).slice(0, 10) : [] },
    filePath,
    coverPath
  };
}

ipcMain.handle('get-user-playlists', () => {
  const lists = db.getUserPlaylists();
  return lists.map((p) => {
    let coverPath = null;
    // If the lead track has no remote artwork but is downloaded, use its local cover
    if (!p.cover_url && p.first_track_id) {
      const dl = db.getTrackById(String(p.first_track_id));
      if (dl && dl.coverName) {
        const cp = safeJoinDownloadDir(settings.downloadDirectory, dl.coverName);
        if (cp && fs.existsSync(cp)) coverPath = cp;
      }
    }
    return {
      id: p.id,
      name: String(p.name || '').slice(0, 120),
      created_at: p.created_at,
      track_count: p.track_count,
      cover_url: (typeof p.cover_url === 'string' && validateUrl(p.cover_url)) ? p.cover_url : null,
      coverPath
    };
  });
});

ipcMain.handle('create-playlist', (event, name) => {
  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 120) return null;
  return db.createPlaylist(name.trim());
});

ipcMain.handle('rename-playlist', (event, { id, name }) => {
  if (!Number.isInteger(id) && !/^\d+$/.test(String(id))) return false;
  if (!name || typeof name !== 'string' || !name.trim() || name.trim().length > 120) return false;
  return db.renamePlaylist(Number(id) || id, name.trim());
});

ipcMain.handle('delete-playlist', (event, id) => {
  if (!Number.isInteger(id) && !/^\d+$/.test(String(id))) return false;
  return db.deletePlaylist(Number(id) || id);
});

ipcMain.handle('add-track-to-playlist', (event, { playlistId, track }) => {
  if ((!Number.isInteger(playlistId) && !/^\d+$/.test(String(playlistId)))) return { ok: false, added: false };
  const clean = sanitizeTrackMeta(track);
  if (!clean) return { ok: false, added: false };
  const normalized = {
    trackId: clean.trackId,
    title: clean.title,
    artist: clean.artist,
    artworkUrl: clean.artworkUrl,
    transcodings: clean.transcodings,
    duration: clean.duration
  };
  const added = db.addTrackToPlaylist(Number(playlistId) || playlistId, normalized);
  return { ok: true, added };
});

ipcMain.handle('remove-track-from-playlist', (event, { playlistId, trackId }) => {
  if ((!Number.isInteger(playlistId) && !/^\d+$/.test(String(playlistId)))) return false;
  if (!isValidTrackId(trackId)) return false;
  return db.removeTrackFromPlaylist(Number(playlistId) || playlistId, String(trackId));
});

ipcMain.handle('get-user-playlist-tracks', (event, playlistId) => {
  if ((!Number.isInteger(playlistId) && !/^\d+$/.test(String(playlistId)))) return { meta: null, tracks: [] };
  const meta = db.getUserPlaylistById(Number(playlistId) || playlistId);
  const tracks = db.getUserPlaylistTracks(Number(playlistId) || playlistId).map(buildPlayableUserTrack).filter(Boolean);
  return { meta, tracks };
});

// Proxied Searching
// Proxied Searching
ipcMain.handle('search-tracks', async (event, query) => {
  if (typeof query !== 'string') throw new Error('Invalid query.');
  const q = query.trim().slice(0, 200);
  if (!q) throw new Error('Empty query.');
  const cacheKey = q.toLowerCase();
  if (searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    if (Date.now() - cached.timestamp < SEARCH_CACHE_TTL) {
      console.log('[Cache Hit] Returning search results.');
      return cached.data;
    }
    searchCache.delete(cacheKey);
  }

  try {
    const clientId = await getClientId();
    if (!isValidClientId(clientId)) throw new Error('Invalid client_id.');
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${clientId}&limit=24`;
    
    if (!validateUrl(url)) throw new Error('Search URL hostname not allowed.');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };

    // Attach OAuth token if logged in
    const token = getOauthToken();
    if (token) {
      headers['Authorization'] = `OAuth ${token}`;
    }

    const res = await axios.get(url, { headers, timeout: 10000, maxContentLength: 5 * 1024 * 1024 });

    // Store in cache
    if (cacheKey) {
      searchCache.set(cacheKey, {
        data: res.data,
        timestamp: Date.now()
      });
      // Limit cache size to 50 entries
      if (searchCache.size > 50) {
        const oldestKey = searchCache.keys().next().value;
        searchCache.delete(oldestKey);
      }
    }

    return res.data;
  } catch (err) {
    console.error('Proxy search failed:', err.message);
    if (err.response?.status === 401 || err.response?.status === 403) {
      console.warn('Unauthorized/Forbidden search error detected. Resetting client ID cache...');
      activeClientId = null;
      try { if (cachePath) fs.unlinkSync(cachePath); } catch (_) {}
    }
    throw new Error(err.response?.data?.message || err.message);
  }
});

// Proxied Stream URL resolution
ipcMain.handle('get-track-stream', async (event, { trackId, transcodings }) => {
  try {
    const clientId = await getClientId();
    if (!isValidClientId(clientId)) throw new Error('Invalid client_id.');

    // Check trackId is strictly numeric
    if (!isValidTrackId(trackId)) {
      throw new Error('Invalid track ID format.');
    }
    if (!validateTranscodings(transcodings)) throw new Error('Invalid transcodings.');

    // Prioritize progressive MP3 stream
    let selectedTranscoding = transcodings.find(t => t.format.protocol === 'progressive');
    if (!selectedTranscoding) {
      selectedTranscoding = transcodings.find(t => t.format.protocol === 'hls');
    }

    if (!selectedTranscoding) {
      throw new Error('No compatible progressive or HLS audio transcodings found.');
    }

    const streamMetaUrl = `${selectedTranscoding.url}?client_id=${clientId}`;
    if (!validateUrl(streamMetaUrl)) throw new Error('Stream metadata URL hostname not allowed.');

    const headers = {};
    const token = getOauthToken();
    if (token) {
      headers['Authorization'] = `OAuth ${token}`;
    }

    const streamMetaRes = await axios.get(streamMetaUrl, { headers, timeout: 10000, maxContentLength: 2 * 1024 * 1024 });
    const retUrl = streamMetaRes.data?.url;
    if (typeof retUrl !== 'string' || !validateUrl(retUrl)) throw new Error('Invalid stream URL from API.');
    
    return {
      url: retUrl,
      protocol: selectedTranscoding.format.protocol
    };
  } catch (err) {
    console.error('Proxy stream resolution failed:', err.message);
    if (err.response?.status === 401 || err.response?.status === 403) {
      console.warn('Unauthorized/Forbidden stream resolution error detected. Resetting client ID cache...');
      activeClientId = null;
      try { if (cachePath) fs.unlinkSync(cachePath); } catch (_) {}
    }
    throw new Error(err.message);
  }
});

// Trigger Track Download
ipcMain.on('download-track', (event, track) => {
  // SECURITY FIX: validate payload; trackId numeric prevents tmp path traversal.
  const clean = sanitizeTrackMeta(track);
  if (!clean) {
    console.warn('Rejected download-track with invalid payload.');
    return;
  }
  // Check if task is already registered
  const tasks = db.getDownloadTasks();
  const existingTask = tasks.find(t => t.trackId === clean.trackId);
  
  if (existingTask) {
    if (existingTask.status === 'failed' || existingTask.status === 'completed') {
      db.deleteDownloadTask(clean.trackId);
    } else {
      return;
    }
  }

  // Save task to SQLite
  db.saveDownloadTask({
    id: clean.trackId,
    title: clean.title,
    artist: clean.artist,
    artwork_url: clean.artworkUrl,
    transcodings: clean.transcodings,
    status: 'queued',
    progress: 0,
    created_at: Date.now()
  });

  memoryQueue.push(clean);
  checkQueue();
});

// Fetch Offline Downloads list
ipcMain.handle('get-downloads', () => {
  const tracksList = db.getTracks();
  
  // Validate that the files actually exist on the disk (with traversal-safe join)
  const validatedList = tracksList.filter(item => {
    const filePath = safeJoinDownloadDir(settings.downloadDirectory, item.fileName);
    return filePath && fs.existsSync(filePath);
  });

  // Sync index if any files were deleted manually from explorer
  if (validatedList.length !== tracksList.length) {
    const ids = new Set(validatedList.map(t => t.id));
    tracksList.forEach(t => {
      if (!ids.has(t.id)) {
        try { db.deleteTrack(t.id); } catch (_) {}
      }
    });
  }

  return validatedList.map(item => ({
    ...item,
    filePath: safeJoinDownloadDir(settings.downloadDirectory, item.fileName),
    coverPath: item.coverName ? safeJoinDownloadDir(settings.downloadDirectory, item.coverName) : null
  })).filter(x => x.filePath);
});

// Delete Offline Download
ipcMain.handle('delete-download', (event, trackId) => {
  try {
    if (!isValidTrackId(trackId)) return false;
    const item = db.getTrackById(String(trackId));
    if (item) {
      const mp3Path = safeJoinDownloadDir(settings.downloadDirectory, item.fileName);
      const jpgPath = item.coverName ? safeJoinDownloadDir(settings.downloadDirectory, item.coverName) : null;
      
      if (mp3Path && fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
      if (jpgPath && fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);

      db.deleteTrack(String(trackId));
      return true;
    }
  } catch (e) {
    console.error('Failed to delete download:', e);
  }
  return false;
});

// Get Download Tasks
ipcMain.handle('get-download-tasks', () => {
  return db.getDownloadTasks();
});

// Delete task
ipcMain.handle('delete-download-task', (event, trackId) => {
  if (!isValidTrackId(trackId)) return false;
  db.deleteDownloadTask(String(trackId));
  return true;
});

// Cancel an active download
ipcMain.handle('cancel-download-task', (event, trackId) => {
  if (!isValidTrackId(trackId)) return false;
  const tid = String(trackId);
  // Remove from memory queue if it's still waiting
  const queueIdx = memoryQueue.findIndex(item => item.trackId === tid);
  if (queueIdx !== -1) {
    memoryQueue.splice(queueIdx, 1);
    db.deleteDownloadTask(tid);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', {
        trackId: tid, status: 'cancelled', progress: 0, error: 'Отменено пользователем', title: '', artist: ''
      });
    }
    return true;
  }

  // Abort an in-progress download
  const entry = activeDownloadControllers.get(tid);
  if (entry) {
    entry.abortController.abort();
    if (entry.ffmpegCmd) {
      try { entry.ffmpegCmd.kill('SIGKILL'); } catch (_) {}
    }
    return true;
  }

  return false;
});

// ----------------------------------------------------
// Authentication Handlers
// ----------------------------------------------------

// Open Sign-In Window & Intercept Cookie
ipcMain.handle('open-auth-window', async () => {
  if (!mainWindow) return null;

  const authWindow = new BrowserWindow({
    width: 480,
    height: 650,
    parent: mainWindow,
    modal: true,
    backgroundColor: '#000000',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
      partition: 'persist:sc-auth'
    }
  });

  authWindow.setMenuBarVisibility(false);
  // SECURITY FIX: isolate auth session, block navigation outside SoundCloud, deny popups/permissions.
  try {
    authWindow.webContents.session.setPermissionRequestHandler((wc, perm, cb) => cb(false));
    authWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());
  } catch (_) {}
  authWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  authWindow.webContents.on('will-navigate', (event, navUrl) => {
    try {
      const u = new URL(navUrl);
      const h = u.hostname.toLowerCase();
      if (!(h === 'soundcloud.com' || h.endsWith('.soundcloud.com'))) {
        event.preventDefault();
      }
    } catch {
      event.preventDefault();
    }
  });
  authWindow.loadURL('https://soundcloud.com/signin');

  let tokenCaptured = false;
  let checkInterval = null;

  const cleanup = () => {
    if (checkInterval) { clearInterval(checkInterval); checkInterval = null; }
  };

  const checkToken = async () => {
    if (tokenCaptured || authWindow.isDestroyed()) return;
    try {
      const cookies = await authWindow.webContents.session.cookies.get({ name: 'oauth_token' });
      // SECURITY FIX: only accept oauth_token scoped to soundcloud.com (prevents evil.com cookie injection).
      const scCookies = cookies.filter(c => (c.domain || '').toLowerCase().includes('soundcloud.com'));
      if (scCookies.length > 0) {
        const token = (scCookies[0].value || '').trim();
        if (!isValidTokenFormat(token)) return;
        tokenCaptured = true;
        cleanup();
        saveOauthToken(token);
        const profile = await fetchUserProfile(token);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth-status', {
            loggedIn: true,
            profile: profile || { username: 'SoundCloud User' }
          });
        }
        if (!authWindow.isDestroyed()) authWindow.close();
        // Clear auth session storage after capture to reduce token residue
        try { await authWindow.webContents.session.clearStorageData({ storages: ['cookies', 'localstorage'] }); } catch (_) {}
      }
    } catch (e) {
      console.error('Auth cookie check error:', e);
    }
  };

  authWindow.webContents.session.cookies.on('changed', (event, cookie, cause, removed) => {
    if (!removed && cookie.name === 'oauth_token' && (cookie.domain || '').toLowerCase().includes('soundcloud.com')) checkToken();
  });

  checkInterval = setInterval(checkToken, 2000);

  authWindow.on('closed', () => {
    cleanup();
    inMemoryToken = inMemoryToken; // keep in-memory token; session partition persists only cookies
  });
});

// Clear token & logout
ipcMain.handle('logout', () => {
  try { db.deleteToken('oauth_token'); } catch (_) {}
  inMemoryToken = null;
  // Clear isolated auth cookies as well
  try {
    const ses = require('electron').session;
    ses.fromPartition('persist:sc-auth').clearStorageData({ storages: ['cookies', 'localstorage'] }).catch(() => {});
  } catch (_) {}
  return { loggedIn: false };
});

// Fetch active profile
ipcMain.handle('get-auth-profile', async () => {
  const token = getOauthToken();
  if (!token || !isValidTokenFormat(token)) return { loggedIn: false };

  const profile = await fetchUserProfile(token);
  if (profile) {
    return { loggedIn: true, profile };
  } else {
    // If token expired/invalid, clear it
    try { db.deleteToken('oauth_token'); } catch (_) {}
    inMemoryToken = null;
    return { loggedIn: false };
  }
});

// Save token manually
ipcMain.handle('save-manual-token', async (event, token) => {
  if (typeof token !== 'string' || !token.trim()) return { loggedIn: false, error: 'Empty token.' };
  if (token.length > 500) return { loggedIn: false, error: 'Токен слишком длинный.' };

  const cleanToken = token.trim();
  if (!isValidTokenFormat(cleanToken)) return { loggedIn: false, error: 'Недействительный формат токена.' };
  const profile = await fetchUserProfile(cleanToken);
  
  if (profile) {
    saveOauthToken(cleanToken);
    return { loggedIn: true, profile };
  } else {
    return { loggedIn: false, error: 'Недействительный токен. Проверьте правильность ввода.' };
  }
});
