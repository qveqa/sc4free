const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let db;

// Cached prepared statements (initialized in initDatabase)
let stmts = {};

function initDatabase(app) {
  const dbPath = path.join(app.getPath('userData'), 'soundcloud_client.db');
  db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  let currentVersion = 0;
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get();
  if (row) currentVersion = parseInt(row.value, 10);

  if (currentVersion < 1) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          title TEXT,
          artist TEXT,
          fileName TEXT,
          coverName TEXT,
          duration INTEGER DEFAULT 0,
          downloadedAt INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_tracks_downloadedAt ON tracks(downloadedAt DESC);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        CREATE TABLE IF NOT EXISTS auth (
          key TEXT PRIMARY KEY,
          value BLOB
        );

        CREATE TABLE IF NOT EXISTS download_tasks (
          id TEXT PRIMARY KEY,
          title TEXT,
          artist TEXT,
          artwork_url TEXT,
          transcodings TEXT,
          status TEXT,
          progress INTEGER DEFAULT 0,
          error TEXT,
          created_at INTEGER,
          updated_at INTEGER
        );
      `);
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '1')").run();
    })();
    console.log('Database schema v1 created.');
  }

  if (currentVersion < 2) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS user_playlists (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          created_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS user_playlist_tracks (
          playlist_id INTEGER NOT NULL,
          track_id TEXT NOT NULL,
          title TEXT,
          artist TEXT,
          artwork_url TEXT,
          transcodings TEXT,
          duration INTEGER DEFAULT 0,
          position INTEGER DEFAULT 0,
          added_at INTEGER,
          PRIMARY KEY (playlist_id, track_id),
          FOREIGN KEY (playlist_id) REFERENCES user_playlists(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_uptracks_playlist ON user_playlist_tracks(playlist_id, position);
      `);
      db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', '2')").run();
    })();
    console.log('Database schema v2 created (user playlists).');
  }

  // Prepare and cache all statements
  stmts = {
    getAppMeta:       db.prepare("SELECT value FROM app_meta WHERE key = ?"),
    getSetting:       db.prepare("SELECT value FROM settings WHERE key = ?"),
    setSetting:       db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)"),
    saveToken:        db.prepare("INSERT OR REPLACE INTO auth (key, value) VALUES (?, ?)"),
    getToken:         db.prepare("SELECT value FROM auth WHERE key = ?"),
    deleteToken:      db.prepare("DELETE FROM auth WHERE key = ?"),
    addTrack:         db.prepare(`INSERT OR REPLACE INTO tracks (id, title, artist, fileName, coverName, duration, downloadedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    getTracks:        db.prepare("SELECT * FROM tracks ORDER BY downloadedAt DESC"),
    getTrackById:     db.prepare("SELECT * FROM tracks WHERE id = ?"),
    deleteTrack:      db.prepare("DELETE FROM tracks WHERE id = ?"),
    saveTask:         db.prepare(`INSERT OR REPLACE INTO download_tasks (id, title, artist, artwork_url, transcodings, status, progress, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getTasks:         db.prepare("SELECT * FROM download_tasks ORDER BY created_at ASC"),
    deleteTask:       db.prepare("DELETE FROM download_tasks WHERE id = ?"),
    resetInterrupted: db.prepare(`UPDATE download_tasks SET status = 'failed', error = 'Загрузка прервана', progress = 0 WHERE status IN ('downloading', 'transcoding', 'tagging')`),
    insertSettingRow: db.prepare("SELECT value FROM settings WHERE key = 'downloadDirectory'"),

    // User playlists
    createPlaylist:    db.prepare("INSERT INTO user_playlists (name, created_at) VALUES (?, ?)"),
    renamePlaylist:    db.prepare("UPDATE user_playlists SET name = ? WHERE id = ?"),
    deletePlaylist:    db.prepare("DELETE FROM user_playlists WHERE id = ?"),
    getPlaylists:      db.prepare(`
      SELECT p.id, p.name, p.created_at,
        (SELECT COUNT(*) FROM user_playlist_tracks t WHERE t.playlist_id = p.id) AS track_count,
        (SELECT t.artwork_url FROM user_playlist_tracks t WHERE t.playlist_id = p.id ORDER BY t.position ASC, t.added_at ASC LIMIT 1) AS cover_url,
        (SELECT t.track_id FROM user_playlist_tracks t WHERE t.playlist_id = p.id ORDER BY t.position ASC, t.added_at ASC LIMIT 1) AS first_track_id
      FROM user_playlists p
      ORDER BY p.created_at DESC
    `),
    getPlaylistById:   db.prepare("SELECT id, name, created_at FROM user_playlists WHERE id = ?"),
    nextPlaylistPos:   db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM user_playlist_tracks WHERE playlist_id = ?"),
    addPlaylistTrack:  db.prepare(`INSERT OR IGNORE INTO user_playlist_tracks
      (playlist_id, track_id, title, artist, artwork_url, transcodings, duration, position, added_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    removePlaylistTrack: db.prepare("DELETE FROM user_playlist_tracks WHERE playlist_id = ? AND track_id = ?"),
    getPlaylistTracks: db.prepare(`SELECT track_id, title, artist, artwork_url, transcodings, duration, position, added_at
      FROM user_playlist_tracks WHERE playlist_id = ? ORDER BY position ASC, added_at ASC`)
  };

  migrateLegacyJson(app);
  resetInterruptedTasks();
}

function migrateLegacyJson(app) {
  let downloadDirectory = path.join(app.getPath('music'), 'SoundCloudOffline');
  try {
    const row = stmts.insertSettingRow.get();
    if (row) downloadDirectory = JSON.parse(row.value);
  } catch (e) {}

  const legacyPath = path.join(downloadDirectory, 'downloads.json');
  if (!fs.existsSync(legacyPath)) return;

  try {
    console.log('Migrating legacy downloads.json to SQLite...');
    const legacyTracks = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
    const insert = db.prepare(`INSERT OR IGNORE INTO tracks (id, title, artist, fileName, coverName, duration, downloadedAt) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    db.transaction(() => {
      for (const t of legacyTracks) {
        insert.run(t.id, t.title, t.artist, t.fileName, t.coverName || null, t.duration || 0, t.downloadedAt || Date.now());
      }
    })();
    fs.renameSync(legacyPath, legacyPath + '.migrated');
    console.log('Legacy migration complete.');
  } catch (e) {
    console.error('Failed to migrate legacy downloads.json:', e);
  }
}

function resetInterruptedTasks() {
  try {
    const result = stmts.resetInterrupted.run();
    if (result.changes > 0) console.log(`Reset ${result.changes} interrupted tasks on startup.`);
  } catch (e) {
    console.error('Failed to reset interrupted tasks:', e);
  }
}

// SETTINGS
function getSetting(key, defaultValue) {
  try {
    const row = stmts.getSetting.get(key);
    if (row) return JSON.parse(row.value);
  } catch (e) {
    console.error(`getSetting(${key}):`, e);
  }
  return defaultValue;
}

function setSetting(key, value) {
  try {
    stmts.setSetting.run(key, JSON.stringify(value));
  } catch (e) {
    console.error(`setSetting(${key}):`, e);
  }
}

// AUTH
function saveToken(key, valueBuffer) {
  try {
    stmts.saveToken.run(key, valueBuffer);
  } catch (e) {
    console.error(`saveToken(${key}):`, e);
  }
}

function getToken(key) {
  try {
    const row = stmts.getToken.get(key);
    return row ? row.value : null;
  } catch (e) {
    console.error(`getToken(${key}):`, e);
    return null;
  }
}

function deleteToken(key) {
  try {
    stmts.deleteToken.run(key);
  } catch (e) {
    console.error(`deleteToken(${key}):`, e);
  }
}

// TRACKS
function addTrack(track) {
  try {
    stmts.addTrack.run(
      track.id, track.title, track.artist, track.fileName,
      track.coverName || null, track.duration || 0, track.downloadedAt || Date.now()
    );
  } catch (e) {
    console.error('addTrack:', e);
  }
}

function getTracks() {
  try {
    return stmts.getTracks.all();
  } catch (e) {
    console.error('getTracks:', e);
    return [];
  }
}

function getTrackById(id) {
  try {
    return stmts.getTrackById.get(id) || null;
  } catch (e) {
    return null;
  }
}

function deleteTrack(id) {
  try {
    stmts.deleteTrack.run(id);
  } catch (e) {
    console.error('deleteTrack:', e);
  }
}

// DOWNLOAD TASKS
function saveDownloadTask(task) {
  try {
    stmts.saveTask.run(
      task.id, task.title, task.artist, task.artwork_url,
      JSON.stringify(task.transcodings || []),
      task.status, task.progress || 0, task.error || null,
      task.created_at || Date.now(), Date.now()
    );
  } catch (e) {
    console.error('saveDownloadTask:', e);
  }
}

function getDownloadTasks() {
  try {
    return stmts.getTasks.all().map(r => ({
      trackId: r.id,
      title: r.title,
      artist: r.artist,
      artworkUrl: r.artwork_url,
      transcodings: JSON.parse(r.transcodings || '[]'),
      status: r.status,
      progress: r.progress,
      error: r.error,
      created_at: r.created_at,
      updated_at: r.updated_at
    }));
  } catch (e) {
    console.error('getDownloadTasks:', e);
    return [];
  }
}

function deleteDownloadTask(id) {
  try {
    stmts.deleteTask.run(id);
  } catch (e) {
    console.error('deleteDownloadTask:', e);
  }
}

// USER PLAYLISTS
function createPlaylist(name) {
  try {
    const info = stmts.createPlaylist.run(String(name).trim().slice(0, 120), Date.now());
    return { id: Number(info.lastInsertRowid), name, track_count: 0 };
  } catch (e) {
    console.error('createPlaylist:', e);
    return null;
  }
}

function renamePlaylist(id, name) {
  try {
    stmts.renamePlaylist.run(String(name).trim().slice(0, 120), id);
    return true;
  } catch (e) {
    console.error('renamePlaylist:', e);
    return false;
  }
}

function deletePlaylist(id) {
  try {
    stmts.deletePlaylist.run(id);
    return true;
  } catch (e) {
    console.error('deletePlaylist:', e);
    return false;
  }
}

function getUserPlaylists() {
  try {
    return stmts.getPlaylists.all();
  } catch (e) {
    console.error('getUserPlaylists:', e);
    return [];
  }
}

function getUserPlaylistById(id) {
  try {
    return stmts.getPlaylistById.get(id) || null;
  } catch (e) {
    return null;
  }
}

function addTrackToPlaylist(playlistId, track) {
  try {
    const posRow = stmts.nextPlaylistPos.get(playlistId);
    const position = posRow ? posRow.pos : 0;
    const info = stmts.addPlaylistTrack.run(
      playlistId,
      String(track.trackId),
      track.title || '',
      track.artist || '',
      track.artworkUrl || '',
      JSON.stringify(track.transcodings || []),
      track.duration || 0,
      position,
      Date.now()
    );
    return info.changes > 0; // false if it was already present
  } catch (e) {
    console.error('addTrackToPlaylist:', e);
    return false;
  }
}

function removeTrackFromPlaylist(playlistId, trackId) {
  try {
    stmts.removePlaylistTrack.run(playlistId, String(trackId));
    return true;
  } catch (e) {
    console.error('removeTrackFromPlaylist:', e);
    return false;
  }
}

function getUserPlaylistTracks(playlistId) {
  try {
    return stmts.getPlaylistTracks.all(playlistId).map(r => ({
      trackId: r.track_id,
      title: r.title,
      artist: r.artist,
      artworkUrl: r.artwork_url,
      transcodings: JSON.parse(r.transcodings || '[]'),
      duration: r.duration,
      position: r.position
    }));
  } catch (e) {
    console.error('getUserPlaylistTracks:', e);
    return [];
  }
}

module.exports = {
  initDatabase,
  getSetting, setSetting,
  saveToken, getToken, deleteToken,
  addTrack, getTracks, getTrackById, deleteTrack,
  saveDownloadTask, getDownloadTasks, deleteDownloadTask,
  createPlaylist, renamePlaylist, deletePlaylist,
  getUserPlaylists, getUserPlaylistById,
  addTrackToPlaylist, removeTrackFromPlaylist, getUserPlaylistTracks
};
