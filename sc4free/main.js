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
      bypassCSP: true
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
axios.defaults.httpAgent = new http.Agent({ keepAlive: true });
axios.defaults.httpsAgent = new https.Agent({ keepAlive: true });

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
    if (!targetUrl || !targetUrl.startsWith('https://')) return false;
    const parsed = new URL(targetUrl);
    const host = parsed.hostname;
    return ALLOWED_HOSTS.has(host) || 
           host.endsWith('.sndcdn.com') || 
           host.endsWith('.soundcloud.com') || 
           host.endsWith('.soundcloud.cloud');
  } catch (e) {
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
  settings.volume = db.getSetting('volume', 0.8);
  settings.repeatMode = db.getSetting('repeatMode', 'none');
  settings.shuffleMode = db.getSetting('shuffleMode', false);
  settings.windowWidth = db.getSetting('windowWidth', 1100);
  settings.windowHeight = db.getSetting('windowHeight', 750);
}

function saveSettingToDB(key, value) {
  db.setSetting(key, value);
}

// ----------------------------------------------------
// Secure Token Management (using safeStorage)
// ----------------------------------------------------
function saveOauthToken(token) {
  if (!token) return;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(token);
      db.saveToken('oauth_token', encrypted);
      console.log('oauth_token encrypted and stored securely.');
    } else {
      // Fallback if safeStorage is not available (dev fallback, though it usually is on Win/Mac)
      db.saveToken('oauth_token', Buffer.from(token, 'utf8'));
      console.warn('safeStorage not available. Token saved as plain text buffer.');
    }
  } catch (e) {
    console.error('Failed to encrypt/save token:', e);
  }
}

function getOauthToken() {
  try {
    const buffer = db.getToken('oauth_token');
    if (!buffer) return null;

    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(buffer);
    } else {
      return buffer.toString('utf8');
    }
  } catch (e) {
    console.error('Failed to decrypt token:', e);
    return null;
  }
}

// Fetch user profile via SoundCloud API /me
async function fetchUserProfile(token) {
  try {
    const clientId = await getClientId();
    const url = `https://api-v2.soundcloud.com/me?client_id=${clientId}`;
    
    // Strict URL check
    if (!validateUrl(url)) throw new Error('Unsafe URL blocked.');

    const res = await axios.get(url, {
      headers: {
        'Authorization': `OAuth ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      },
      timeout: 8000
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
  if (activeClientId) return activeClientId;

  // Try loading from cache
  let cached = null;
  try {
    if (fs.existsSync(cachePath)) {
      cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      const oneDay = 24 * 60 * 60 * 1000;
      if (cached.clientId && cached.validatedAt && (Date.now() - cached.validatedAt < 3 * oneDay)) {
        // Cache is young, trust it without validating to make first search/action instant
        console.log('Using cached client_id without validation:', cached.clientId);
        activeClientId = cached.clientId;
        return activeClientId;
      } else if (cached.clientId && cached.validatedAt && (Date.now() - cached.validatedAt < 7 * oneDay)) {
        const isValid = await validateClientId(cached.clientId);
        if (isValid) {
          console.log('Using cached client_id:', cached.clientId);
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
  if (newId) {
    activeClientId = newId;
    try {
      fs.writeFileSync(cachePath, JSON.stringify({
        clientId: newId,
        validatedAt: Date.now()
      }, null, 2), 'utf8');
    } catch (e) {
      console.error('Failed to save client_id cache:', e);
    }
    return newId;
  }

  const fallback = 'iZ6gthvODSYgDRB5wo1cm51LSbs0uqO2';
  console.log('Scraping failed, using fallback client_id:', fallback);
  activeClientId = fallback;
  return fallback;
}

async function validateClientId(id) {
  try {
    const url = `https://api-v2.soundcloud.com/search/tracks?q=chill&client_id=${id}&limit=1`;
    if (!validateUrl(url)) return false;
    const res = await axios.get(url, { timeout: 5000 });
    return res.status === 200;
  } catch (e) {
    return false;
  }
}

async function scrapeClientId() {
  try {
    const res = await axios.get('https://soundcloud.com', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    const html = res.data;

    const scriptRegex = /<script[^>]+src=["'](https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js)["']/g;
    let match;
    const scriptUrls = [];
    while ((match = scriptRegex.exec(html)) !== null) {
      scriptUrls.push(match[1]);
    }
    scriptUrls.reverse();

    for (const url of scriptUrls) {
      try {
        if (!validateUrl(url)) continue; // Whitelist check on scripts
        const jsRes = await axios.get(url, { timeout: 5000 });
        const js = jsRes.data;
        const idMatch = js.match(/client_id\s*:\s*["']([a-zA-Z0-9]{32})["']/);
        if (idMatch && idMatch[1]) {
          console.log(`Found client_id: ${idMatch[1]}`);
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
      const decodedPath = decodeURIComponent(rawPath);
      
      const filePath = process.platform === 'win32' && decodedPath.startsWith('/')
        ? decodedPath.slice(1)
        : decodedPath;

      // Prevent loading files outside of allowed scopes (like windows system directories)
      // Limit access to settings.downloadDirectory or standard music folders
      const normalizedFile = path.normalize(filePath);
      const normalizedDownloadDir = path.normalize(settings.downloadDirectory);
      
      const isAllowed = process.platform === 'win32'
        ? normalizedFile.toLowerCase().startsWith(normalizedDownloadDir.toLowerCase())
        : normalizedFile.startsWith(normalizedDownloadDir);

      if (!isAllowed) {
        console.warn(`Blocked unauthorized local file access: ${normalizedFile}`);
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
  const tempDir = path.join(settings.downloadDirectory, '.temp');
  try {
    if (fs.existsSync(tempDir)) {
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
  // Strip forbidden filesystem characters (not dots — dots are valid in filenames)
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  // Limit to 180 chars to stay well within Windows MAX_PATH limits
  return safe.slice(0, 180);
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
  const { trackId, title, artist, artworkUrl, transcodings } = item;

  // Create an AbortController for this download
  const abortController = new AbortController();
  activeDownloadControllers.set(trackId, { abortController, ffmpegCmd: null });
  
  // Safe sanitizations
  const safeArtist = sanitizeFilename(artist);
  const safeTitle = sanitizeFilename(title);
  const baseName = `${safeArtist} - ${safeTitle}`;
  const outDir = settings.downloadDirectory;
  const tempDir = path.join(outDir, '.temp');
  
  const mp3Path = path.join(outDir, `${baseName}.mp3`);
  const jpgPath = path.join(outDir, `${baseName}.jpg`);
  const tmpMp3Path = path.join(tempDir, `${trackId}.tmp.mp3`);
  const tmpJpgPath = path.join(tempDir, `${trackId}.tmp.jpg`);

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

    // Step 1: Download Cover Art
    updateStatus('downloading', 5);
    let coverBuffer = null;
    if (artworkUrl) {
      try {
        if (!validateUrl(artworkUrl)) throw new Error('Cover art URL not whitelisted.');
        const coverRes = await axios.get(artworkUrl, { responseType: 'arraybuffer', timeout: 8000 });
        coverBuffer = Buffer.from(coverRes.data);
        fs.writeFileSync(tmpJpgPath, coverBuffer);
      } catch (err) {
        console.warn('Failed to download cover art:', err.message);
      }
    }

    // Step 2: Resolve stream URL
    updateStatus('downloading', 15);
    const clientId = await getClientId();
    
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

    const streamMetaRes = await axios.get(streamMetaUrl);
    const directStreamUrl = streamMetaRes.data.url;

    if (!directStreamUrl || !validateUrl(directStreamUrl)) {
      throw new Error('Could not resolve secure streaming CDN URL.');
    }

    // Step 3: Download & Transcode Audio
    updateStatus('downloading', 25);

    if (isHls) {
      // HLS download using ffmpeg (spawned directly, protecting against shell injections)
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(directStreamUrl)
          .inputOptions([
            '-http_persistent 1',
            '-threads 4'
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
      });
    } else {
      // Progressive MP3 download via axios stream
      const writer = fs.createWriteStream(tmpMp3Path, { highWaterMark: 1024 * 1024 });
      const streamRes = await axios({
        url: directStreamUrl,
        method: 'GET',
        responseType: 'stream',
        signal: abortController.signal
      });

      const totalLength = parseInt(streamRes.headers['content-length'] || '0', 10);
      let downloadedLength = 0;

      streamRes.data.on('data', (chunk) => {
        downloadedLength += chunk.length;
        if (totalLength > 0) {
          const progress = Math.min(80, 25 + Math.round((downloadedLength / totalLength) * 55));
          updateStatus('downloading', progress);
        }
      });

      streamRes.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', (err) => {
          writer.destroy();
          reject(err);
        });
      });
    }

    // Check if cancelled between steps
    if (abortController.signal.aborted) throw new Error('CANCELLED');

    // Step 4: File Integrity Verification (Size must be > 100KB)
    if (!fs.existsSync(tmpMp3Path)) {
      throw new Error('Downloaded temporary file not found on disk.');
    }
    const fileSize = fs.statSync(tmpMp3Path).size;
    if (fileSize < 100 * 1024) {
      throw new Error(`File integrity check failed: downloaded file size (${Math.round(fileSize/1024)} KB) is too small.`);
    }

    // Step 5: Tag Metadata (Title, Artist, Album, Cover Art)
    updateStatus('tagging', 85);
    const tags = {
      title: title,
      artist: artist,
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
      title,
      artist,
      fileName: `${baseName}.mp3`,
      coverName: coverBuffer ? `${baseName}.jpg` : null,
      duration: item.duration || 0,
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
      sandbox: true // Run renderer inside isolated sandbox
    }
  });

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
  settings = { ...settings, ...newSettings };
  for (const [key, val] of Object.entries(newSettings)) {
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
    settings.downloadDirectory = newDir;
    saveSettingToDB('downloadDirectory', newDir);
    cleanTempDirectory(); // setup temp folder inside the new path
    return newDir;
  }
  return null;
});

// Open URL in system browser
ipcMain.handle('open-external', (event, url) => {
  const allowed = ['https://github.com/qveqa'];
  if (allowed.some(u => url.startsWith(u))) {
    shell.openExternal(url);
  }
});

// Search playlists
ipcMain.handle('search-playlists', async (event, query) => {
  try {
    const clientId = await getClientId();
    const url = `https://api-v2.soundcloud.com/search/playlists?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=16`;
    if (!validateUrl(url)) throw new Error('Playlist search URL not allowed.');

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    const token = getOauthToken();
    if (token) headers['Authorization'] = `OAuth ${token}`;

    const res = await axios.get(url, { headers, timeout: 10000 });
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
    if (!/^\d+$/.test(String(playlistId))) throw new Error('Invalid playlist ID.');

    const clientId = await getClientId();
    const url = `https://api-v2.soundcloud.com/playlists/${playlistId}?client_id=${clientId}`;
    if (!validateUrl(url)) throw new Error('Playlist URL not allowed.');

    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
    const token = getOauthToken();
    if (token) headers['Authorization'] = `OAuth ${token}`;

    const res = await axios.get(url, { headers, timeout: 15000 });
    return res.data;
  } catch (err) {
    console.error('Get playlist failed:', err.message);
    if (err.response?.status === 401 || err.response?.status === 403) {
      activeClientId = null;
      try { fs.unlinkSync(cachePath); } catch (_) {}
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
  const downloaded = db.getTrackById(String(t.trackId));
  if (downloaded) {
    const fp = path.join(settings.downloadDirectory, downloaded.fileName);
    if (fs.existsSync(fp)) {
      filePath = fp;
      coverPath = downloaded.coverName
        ? path.join(settings.downloadDirectory, downloaded.coverName)
        : null;
    }
  }
  return {
    id: String(t.trackId),
    trackId: String(t.trackId),
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    artwork_url: t.artworkUrl || null,
    media: { transcodings: t.transcodings || [] },
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
        const cp = path.join(settings.downloadDirectory, dl.coverName);
        if (fs.existsSync(cp)) coverPath = cp;
      }
    }
    return {
      id: p.id,
      name: p.name,
      created_at: p.created_at,
      track_count: p.track_count,
      cover_url: p.cover_url || null,
      coverPath
    };
  });
});

ipcMain.handle('create-playlist', (event, name) => {
  if (!name || !String(name).trim()) return null;
  return db.createPlaylist(name);
});

ipcMain.handle('rename-playlist', (event, { id, name }) => {
  if (!name || !String(name).trim()) return false;
  return db.renamePlaylist(id, name);
});

ipcMain.handle('delete-playlist', (event, id) => {
  return db.deletePlaylist(id);
});

ipcMain.handle('add-track-to-playlist', (event, { playlistId, track }) => {
  if (!playlistId || !track || !track.trackId) return { ok: false, added: false };
  const added = db.addTrackToPlaylist(playlistId, track);
  return { ok: true, added };
});

ipcMain.handle('remove-track-from-playlist', (event, { playlistId, trackId }) => {
  return db.removeTrackFromPlaylist(playlistId, trackId);
});

ipcMain.handle('get-user-playlist-tracks', (event, playlistId) => {
  const meta = db.getUserPlaylistById(playlistId);
  const tracks = db.getUserPlaylistTracks(playlistId).map(buildPlayableUserTrack);
  return { meta, tracks };
});

// Proxied Searching
ipcMain.handle('search-tracks', async (event, query) => {
  const cacheKey = (query || '').trim().toLowerCase();
  if (cacheKey && searchCache.has(cacheKey)) {
    const cached = searchCache.get(cacheKey);
    if (Date.now() - cached.timestamp < SEARCH_CACHE_TTL) {
      console.log(`[Cache Hit] Returning search results for query: "${query}"`);
      return cached.data;
    }
    searchCache.delete(cacheKey);
  }

  try {
    const clientId = await getClientId();
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=24`;
    
    if (!validateUrl(url)) throw new Error('Search URL hostname not allowed.');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
    };

    // Attach OAuth token if logged in
    const token = getOauthToken();
    if (token) {
      headers['Authorization'] = `OAuth ${token}`;
    }

    const res = await axios.get(url, { headers });

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
      try { fs.unlinkSync(cachePath); } catch (_) {}
    }
    throw new Error(err.response?.data?.message || err.message);
  }
});

// Proxied Stream URL resolution
ipcMain.handle('get-track-stream', async (event, { trackId, transcodings }) => {
  try {
    const clientId = await getClientId();

    // Check trackId is strictly numeric
    if (!/^\d+$/.test(trackId)) {
      throw new Error('Invalid track ID format.');
    }

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

    const streamMetaRes = await axios.get(streamMetaUrl, { headers });
    
    return {
      url: streamMetaRes.data.url,
      protocol: selectedTranscoding.format.protocol
    };
  } catch (err) {
    console.error('Proxy stream resolution failed:', err.message);
    if (err.response?.status === 401 || err.response?.status === 403) {
      console.warn('Unauthorized/Forbidden stream resolution error detected. Resetting client ID cache...');
      activeClientId = null;
      try { fs.unlinkSync(cachePath); } catch (_) {}
    }
    throw new Error(err.message);
  }
});

// Trigger Track Download
ipcMain.on('download-track', (event, track) => {
  // Check if task is already registered
  const tasks = db.getDownloadTasks();
  const existingTask = tasks.find(t => t.trackId === track.trackId);
  
  if (existingTask) {
    if (existingTask.status === 'failed' || existingTask.status === 'completed') {
      db.deleteDownloadTask(track.trackId);
    } else {
      return;
    }
  }

  // Save task to SQLite
  db.saveDownloadTask({
    id: track.trackId,
    title: track.title,
    artist: track.artist,
    artwork_url: track.artworkUrl,
    transcodings: track.transcodings,
    status: 'queued',
    progress: 0,
    created_at: Date.now()
  });

  memoryQueue.push(track);
  checkQueue();
});

// Fetch Offline Downloads list
ipcMain.handle('get-downloads', () => {
  const tracksList = db.getTracks();
  
  // Validate that the files actually exist on the disk
  const validatedList = tracksList.filter(item => {
    const filePath = path.join(settings.downloadDirectory, item.fileName);
    return fs.existsSync(filePath);
  });

  // Sync index if any files were deleted manually from explorer
  if (validatedList.length !== tracksList.length) {
    const ids = new Set(validatedList.map(t => t.id));
    tracksList.forEach(t => {
      if (!ids.has(t.id)) db.deleteTrack(t.id);
    });
  }

  return validatedList.map(item => ({
    ...item,
    filePath: path.join(settings.downloadDirectory, item.fileName),
    coverPath: item.coverName ? path.join(settings.downloadDirectory, item.coverName) : null
  }));
});

// Delete Offline Download
ipcMain.handle('delete-download', (event, trackId) => {
  try {
    const item = db.getTrackById(trackId);
    if (item) {
      const mp3Path = path.join(settings.downloadDirectory, item.fileName);
      const jpgPath = item.coverName ? path.join(settings.downloadDirectory, item.coverName) : null;
      
      if (fs.existsSync(mp3Path)) fs.unlinkSync(mp3Path);
      if (jpgPath && fs.existsSync(jpgPath)) fs.unlinkSync(jpgPath);

      db.deleteTrack(trackId);
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
  db.deleteDownloadTask(trackId);
  return true;
});

// Cancel an active download
ipcMain.handle('cancel-download-task', (event, trackId) => {
  // Remove from memory queue if it's still waiting
  const queueIdx = memoryQueue.findIndex(item => item.trackId === trackId);
  if (queueIdx !== -1) {
    memoryQueue.splice(queueIdx, 1);
    db.deleteDownloadTask(trackId);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('download-progress', {
        trackId, status: 'cancelled', progress: 0, error: 'Отменено пользователем', title: '', artist: ''
      });
    }
    return true;
  }

  // Abort an in-progress download
  const entry = activeDownloadControllers.get(trackId);
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
      sandbox: true
    }
  });

  authWindow.setMenuBarVisibility(false);
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
      if (cookies.length > 0) {
        tokenCaptured = true;
        cleanup();
        const token = cookies[0].value;
        saveOauthToken(token);
        const profile = await fetchUserProfile(token);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('auth-status', {
            loggedIn: true,
            profile: profile || { username: 'SoundCloud User' }
          });
        }
        if (!authWindow.isDestroyed()) authWindow.close();
      }
    } catch (e) {
      console.error('Auth cookie check error:', e);
    }
  };

  authWindow.webContents.session.cookies.on('changed', (event, cookie, cause, removed) => {
    if (!removed && cookie.name === 'oauth_token') checkToken();
  });

  checkInterval = setInterval(checkToken, 2000);

  authWindow.on('closed', () => {
    cleanup();
  });
});

// Clear token & logout
ipcMain.handle('logout', () => {
  db.deleteToken('oauth_token');
  return { loggedIn: false };
});

// Fetch active profile
ipcMain.handle('get-auth-profile', async () => {
  const token = getOauthToken();
  if (!token) return { loggedIn: false };

  const profile = await fetchUserProfile(token);
  if (profile) {
    return { loggedIn: true, profile };
  } else {
    // If token expired/invalid, clear it
    db.deleteToken('oauth_token');
    return { loggedIn: false };
  }
});

// Save token manually
ipcMain.handle('save-manual-token', async (event, token) => {
  if (!token || !token.trim()) return { loggedIn: false, error: 'Empty token.' };

  const cleanToken = token.trim();
  const profile = await fetchUserProfile(cleanToken);
  
  if (profile) {
    saveOauthToken(cleanToken);
    return { loggedIn: true, profile };
  } else {
    return { loggedIn: false, error: 'Недействительный токен. Проверьте правильность ввода.' };
  }
});
