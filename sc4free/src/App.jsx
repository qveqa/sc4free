import React, { useState, useEffect, useRef } from 'react';
import Sidebar from './components/Sidebar.jsx';
import SearchTab from './components/SearchTab.jsx';
import DownloadsTab from './components/DownloadsTab.jsx';
import SettingsTab from './components/SettingsTab.jsx';
import Playbar from './components/Playbar.jsx';
import PlaylistsTab from './components/PlaylistsTab.jsx';

export default function App() {
  const [activeTab, setActiveTab] = useState('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [playlistQuery, setPlaylistQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [settings, setSettings] = useState({
    downloadDirectory: '',
    volume: 0.8,
    repeatMode: 'none',
    shuffleMode: false
  });

  // User Profile Auth State
  const [userProfile, setUserProfile] = useState(null);

  // Audio Playback Engine States
  const [queue, setQueue] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Background downloads queue tracker
  const [downloadsInProgress, setDownloadsInProgress] = useState({});

  // Audio element reference
  const audioRef = useRef(null);

  // 1. Initial settings and Auth loading
  useEffect(() => {
    async function loadInitialData() {
      try {
        const currentSettings = await window.api.getSettings();
        setSettings(currentSettings);

        const auth = await window.api.getAuthProfile();
        if (auth.loggedIn) {
          setUserProfile(auth.profile);
        }
      } catch (e) {
        console.error('Failed to load initial settings or auth profile:', e);
      }
    }
    loadInitialData();
  }, []);

  // 2. Download and Auth Listeners
  useEffect(() => {
    const unsubscribeProgress = window.api.onDownloadProgress((data) => {
      const { trackId, status, progress, error, title, artist } = data;
      setDownloadsInProgress((prev) => ({
        ...prev,
        [trackId]: { trackId, status, progress, error, title, artist }
      }));
    });

    const unsubscribeAuth = window.api.onAuthStatus((data) => {
      if (data.loggedIn) {
        setUserProfile(data.profile);
      } else {
        setUserProfile(null);
      }
    });

    return () => {
      if (unsubscribeProgress) unsubscribeProgress();
      if (unsubscribeAuth) unsubscribeAuth();
    };
  }, []);

  // Sync settings helper
  const handleUpdateSettings = async (updatedSettings) => {
    try {
      const saved = await window.api.saveSettings(updatedSettings);
      setSettings(saved);
    } catch (e) {
      console.error('Failed to update settings:', e);
    }
  };

  const currentTrack = queue[currentIndex] || null;
  const activeDownloads = Object.values(downloadsInProgress).filter(
    item => item.status !== 'completed' && item.status !== 'failed'
  );

  // 3. Playback Controls
  const playTrack = async (track, newQueue = null) => {
    try {
      setIsPlaying(false);
      
      let streamUrl = '';
      if (track.filePath) {
        // Offline playback from database paths
        streamUrl = `media://path/${encodeURIComponent(track.filePath.replace(/\\/g, '/'))}`;
      } else {
        // Online streaming (direct CDN link resolved in main process)
        const streamData = await window.api.getTrackStream(track.id.toString(), track.media.transcodings);
        streamUrl = streamData.url;
      }

      if (audioRef.current) {
        audioRef.current.src = streamUrl;
        audioRef.current.volume = settings.volume;
        audioRef.current.load();
        
        audioRef.current.play()
          .then(() => setIsPlaying(true))
          .catch((err) => {
            console.error('Audio playback rejected:', err);
            setIsPlaying(false);
          });
      }

      if (newQueue) {
        setQueue(newQueue);
        const idx = newQueue.findIndex(t => (t.id === track.id || t.trackId === track.trackId));
        setCurrentIndex(idx);
      } else {
        const idx = queue.findIndex(t => t.id === track.id);
        if (idx !== -1) {
          setCurrentIndex(idx);
        } else {
          const updatedQueue = [...queue];
          const insertIdx = currentIndex + 1;
          updatedQueue.splice(insertIdx, 0, track);
          setQueue(updatedQueue);
          setCurrentIndex(insertIdx);
        }
      }
    } catch (err) {
      console.error('Failed to resolve stream URL or play track:', err);
      alert('Не удалось воспроизвести трек. Проверьте сеть или авторизацию.');
    }
  };

  const handlePlayPause = () => {
    if (!audioRef.current || !currentTrack) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      audioRef.current.play()
        .then(() => setIsPlaying(true))
        .catch(err => console.error(err));
    }
  };

  const getNextIndex = () => {
    if (queue.length === 0) return -1;
    if (settings.shuffleMode) {
      return Math.floor(Math.random() * queue.length);
    }
    const nextIdx = currentIndex + 1;
    if (nextIdx >= queue.length) {
      return settings.repeatMode === 'all' ? 0 : -1;
    }
    return nextIdx;
  };

  const getPreviousIndex = () => {
    if (queue.length === 0) return -1;
    const prevIdx = currentIndex - 1;
    if (prevIdx < 0) {
      return settings.repeatMode === 'all' ? queue.length - 1 : -1;
    }
    return prevIdx;
  };

  const handleNext = () => {
    const nextIdx = getNextIndex();
    if (nextIdx !== -1) {
      playTrack(queue[nextIdx]);
    } else {
      setIsPlaying(false);
      if (audioRef.current) audioRef.current.currentTime = 0;
    }
  };

  const handlePrevious = () => {
    const prevIdx = getPreviousIndex();
    if (prevIdx !== -1) {
      playTrack(queue[prevIdx]);
    } else {
      if (audioRef.current) audioRef.current.currentTime = 0;
    }
  };

  const handleSeek = (time) => {
    if (audioRef.current) {
      audioRef.current.currentTime = time;
      setCurrentTime(time);
    }
  };

  const handleVolumeChange = (vol) => {
    const safeVol = Math.max(0, Math.min(1, vol));
    if (audioRef.current) {
      audioRef.current.volume = safeVol;
    }
    setSettings(prev => ({ ...prev, volume: safeVol }));
    handleUpdateSettings({ volume: safeVol });
  };

  const handleToggleShuffle = () => {
    const newVal = !settings.shuffleMode;
    setSettings(prev => ({ ...prev, shuffleMode: newVal }));
    handleUpdateSettings({ shuffleMode: newVal });
  };

  const handleToggleRepeat = () => {
    let newMode = 'none';
    if (settings.repeatMode === 'none') newMode = 'all';
    else if (settings.repeatMode === 'all') newMode = 'one';
    
    setSettings(prev => ({ ...prev, repeatMode: newMode }));
    handleUpdateSettings({ repeatMode: newMode });
  };

  // 4. Media Session API Hook (Hardware Media Keys Integration)
  useEffect(() => {
    if (!navigator.mediaSession || !currentTrack) return;

    const artistName = currentTrack.artist || currentTrack.user?.username || 'SoundCloud';
    const fallbackUrl = currentTrack.artwork_url || currentTrack.user?.avatar_url;
    const coverUrl = currentTrack.coverPath
      ? `media://path/${encodeURIComponent(currentTrack.coverPath.replace(/\\/g, '/'))}`
      : fallbackUrl
        ? fallbackUrl.replace('http://', 'https://').replace('-large.jpg', '-t500x500.jpg')
        : 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentTrack.title,
      artist: artistName,
      album: 'SoundCloud Offline',
      artwork: [{ src: coverUrl, sizes: '500x500', type: 'image/jpeg' }]
    });

    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';

    navigator.mediaSession.setActionHandler('play', handlePlayPause);
    navigator.mediaSession.setActionHandler('pause', handlePlayPause);
    navigator.mediaSession.setActionHandler('previoustrack', handlePrevious);
    navigator.mediaSession.setActionHandler('nexttrack', handleNext);

    return () => {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
      navigator.mediaSession.setActionHandler('previoustrack', null);
      navigator.mediaSession.setActionHandler('nexttrack', null);
    };
  }, [currentTrack, isPlaying, queue, currentIndex]);

  // Audio lifecycle bindings
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Some downloaded/transcoded MP3s report audio.duration as Infinity or NaN.
    // Fall back to the track's known duration (stored in ms) so the seek bar and
    // time labels work for offline files.
    const resolveDuration = () => {
      const d = audio.duration;
      if (isFinite(d) && d > 0) return d;
      const track = queue[currentIndex];
      if (track && track.duration > 0) return track.duration / 1000;
      return 0;
    };

    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onDurationChange = () => setDuration(resolveDuration());
    const onLoadedMetadata = () => setDuration(resolveDuration());
    const onEnded = () => {
      if (settings.repeatMode === 'one') {
        audio.currentTime = 0;
        audio.play().catch(e => console.error(e));
      } else {
        handleNext();
      }
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('ended', onEnded);
    };
  }, [queue, currentIndex, settings.repeatMode, settings.shuffleMode]);

  const handleLogout = async () => {
    try {
      const res = await window.api.logout();
      if (!res.loggedIn) {
        setUserProfile(null);
      }
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="app-container">
      <div className="main-content">
        <Sidebar
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          userProfile={userProfile}
          onLogout={handleLogout}
        />
        
        <div className="content-pane">
          {activeTab === 'search' && (
            <SearchTab
              onPlayTrack={(track) => playTrack(track, null)}
              downloadsInProgress={downloadsInProgress}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              query={searchQuery}
              setQuery={setSearchQuery}
              tracks={searchResults}
              setTracks={setSearchResults}
            />
          )}

          {activeTab === 'playlists' && (
            <PlaylistsTab
              onPlayTrack={(track, newQueue) => playTrack(track, newQueue)}
              downloadsInProgress={downloadsInProgress}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
              query={playlistQuery}
              setQuery={setPlaylistQuery}
            />
          )}

          {activeTab === 'downloads' && (
            <DownloadsTab
              downloadsInProgress={downloadsInProgress}
              onPlayOfflineTrack={(track, offlineQueue) => playTrack(track, offlineQueue)}
              currentTrack={currentTrack}
              isPlaying={isPlaying}
              onPlayPause={handlePlayPause}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsTab
              settings={settings}
              onUpdateSettings={handleUpdateSettings}
              userProfile={userProfile}
              onLogout={handleLogout}
            />
          )}
        </div>
      </div>

      <Playbar
        track={currentTrack}
        isPlaying={isPlaying}
        onPlayPause={handlePlayPause}
        onNext={handleNext}
        onPrevious={handlePrevious}
        currentTime={currentTime}
        duration={duration}
        onSeek={handleSeek}
        volume={settings.volume}
        onVolumeChange={handleVolumeChange}
        shuffleMode={settings.shuffleMode}
        onToggleShuffle={handleToggleShuffle}
        repeatMode={settings.repeatMode}
        onToggleRepeat={handleToggleRepeat}
      />

      <audio ref={audioRef} />

      {activeDownloads.length > 0 && (
        <div className="global-download-hud">
          <div className="hud-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.06)', paddingBottom: '6px', marginBottom: '6px' }}>
            <span style={{ fontSize: '11px', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Активные загрузки ({activeDownloads.length})</span>
          </div>
          {activeDownloads.slice(0, 2).map((item) => (
            <div key={item.trackId} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div className="hud-progress-container">
                <div className="hud-spinner"></div>
                <div className="hud-info">
                  <div className="hud-title-text">{item.title || 'Скачивание...'}</div>
                  <div className="hud-status-text">
                    {item.artist ? `${item.artist} • ` : ''}
                    {item.status === 'queued' && 'В очереди'}
                    {item.status === 'downloading' && `Скачивание (${item.progress}%)`}
                    {item.status === 'transcoding' && 'Обработка'}
                    {item.status === 'tagging' && 'Тегирование'}
                  </div>
                </div>
              </div>
              {item.status === 'downloading' && (
                <div className="hud-bar-wrapper">
                  <div className="hud-bar-fill" style={{ width: `${item.progress}%` }}></div>
                </div>
              )}
            </div>
          ))}
          {activeDownloads.length > 2 && (
            <div style={{ fontSize: '10px', color: 'var(--text-secondary)', textAlign: 'center', marginTop: '4px' }}>
              и еще {activeDownloads.length - 2} в очереди...
            </div>
          )}
        </div>
      )}
    </div>
  );
}
