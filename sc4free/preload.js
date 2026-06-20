const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Settings IPCs
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectDownloadDir: () => ipcRenderer.invoke('select-download-dir'),

  // SoundCloud API IPCs
  searchTracks: (query) => ipcRenderer.invoke('search-tracks', query),
  getTrackStream: (trackId, transcodings) => ipcRenderer.invoke('get-track-stream', { trackId, transcodings }),

  // Downloads / Tracks Database IPCs
  downloadTrack: (track) => ipcRenderer.send('download-track', track),
  getDownloads: () => ipcRenderer.invoke('get-downloads'),
  deleteDownload: (trackId) => ipcRenderer.invoke('delete-download', trackId),
  getDownloadTasks: () => ipcRenderer.invoke('get-download-tasks'),
  deleteDownloadTask: (trackId) => ipcRenderer.invoke('delete-download-task', trackId),

  // Authentication IPCs
  openAuthWindow: () => ipcRenderer.invoke('open-auth-window'),
  logout: () => ipcRenderer.invoke('logout'),
  getAuthProfile: () => ipcRenderer.invoke('get-auth-profile'),
  saveManualToken: (token) => ipcRenderer.invoke('save-manual-token', token),

  // Event listeners
  onDownloadProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('download-progress', listener);
    return () => ipcRenderer.removeListener('download-progress', listener);
  },
  onAuthStatus: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('auth-status', listener);
    return () => ipcRenderer.removeListener('auth-status', listener);
  },

  // Shell utilities
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Cancel an active download
  cancelDownloadTask: (trackId) => ipcRenderer.invoke('cancel-download-task', trackId),

  // Playlists (SoundCloud)
  searchPlaylists: (query) => ipcRenderer.invoke('search-playlists', query),
  getPlaylist: (playlistId) => ipcRenderer.invoke('get-playlist', playlistId),

  // User-created playlists (local)
  getUserPlaylists: () => ipcRenderer.invoke('get-user-playlists'),
  createPlaylist: (name) => ipcRenderer.invoke('create-playlist', name),
  renamePlaylist: (id, name) => ipcRenderer.invoke('rename-playlist', { id, name }),
  deletePlaylist: (id) => ipcRenderer.invoke('delete-playlist', id),
  addTrackToPlaylist: (playlistId, track) => ipcRenderer.invoke('add-track-to-playlist', { playlistId, track }),
  removeTrackFromPlaylist: (playlistId, trackId) => ipcRenderer.invoke('remove-track-from-playlist', { playlistId, trackId }),
  getUserPlaylistTracks: (playlistId) => ipcRenderer.invoke('get-user-playlist-tracks', playlistId)
});
