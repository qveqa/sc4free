import React, { useState, useEffect, useCallback, useRef, memo } from 'react';
import MyPlaylistsView from './MyPlaylistsView.jsx';
import AddToPlaylist from './AddToPlaylist.jsx';

// High-res cover URL helper
const getHighResCover = (url) => {
  if (!url) return 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';
  return url.replace('http://', 'https://').replace('-large.jpg', '-t500x500.jpg');
};

// Memoised playlist card
const PlaylistCard = memo(function PlaylistCard({ playlist, onClick }) {
  const cover = getHighResCover(playlist.artwork_url || playlist.tracks?.[0]?.artwork_url);
  const count = playlist.track_count ?? playlist.tracks?.length ?? 0;
  return (
    <div className="track-card playlist-card" onClick={onClick} style={{ cursor: 'pointer' }}>
      <div className="card-cover-container">
        <img className="card-cover" src={cover} alt={playlist.title} />
        <div className="playlist-card-count">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
          {count} треков
        </div>
      </div>
      <div className="card-title" title={playlist.title}>{playlist.title}</div>
      <div className="card-artist" title={playlist.user?.username}>{playlist.user?.username}</div>
    </div>
  );
});

// Memoised track row inside a playlist detail
const PlaylistTrackRow = memo(function PlaylistTrackRow({ track, index, isCurrent, showPause, isDownloading, onPlay, onDownload }) {
  const cover = getHighResCover(track.artwork_url || track.user?.avatar_url);
  const dur = track.duration ? formatDuration(track.duration) : '--:--';
  return (
    <div className={`offline-row${isCurrent ? ' offline-row--active' : ''}`} onClick={onPlay} style={{ cursor: 'pointer' }}>
      <div className="offline-track-info">
        <div className="offline-cover-wrap" style={{ position: 'relative' }}>
          <img className="offline-cover" src={cover} alt={track.title} />
          <div className={`offline-play-overlay${isCurrent ? ' offline-play-overlay--visible' : ''}`}>
            {showPause
              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
              : <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            }
          </div>
        </div>
        <div className="offline-text">
          <span className={`offline-title${isCurrent ? ' offline-title--active' : ''}`}>{track.title}</span>
          <span className="offline-artist">{track.user?.username}</span>
        </div>
      </div>
      <div className="offline-actions" onClick={(e) => e.stopPropagation()}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginRight: '8px' }}>{dur}</span>
        <AddToPlaylist
          track={{
            trackId: String(track.id),
            title: track.title,
            artist: track.user?.username || 'Unknown',
            artworkUrl: cover,
            transcodings: track.media?.transcodings || [],
            duration: track.duration
          }}
          variant="row"
        />
        <button
          className="download-action-btn"
          style={{ width: '32px', height: '32px', padding: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'static', opacity: 1, transform: 'none',
            ...(isDownloading ? { background: '#fff', color: '#000' } : {})
          }}
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          disabled={isDownloading}
          title="Скачать трек"
        >
          {isDownloading
            ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s linear infinite' }}><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
            : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          }
        </button>
      </div>
    </div>
  );
});

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function ModeTabs({ mode, setMode }) {
  return (
    <div className="mpl-toggle">
      <button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>Поиск SoundCloud</button>
      <button className={mode === 'mine' ? 'active' : ''} onClick={() => setMode('mine')}>Мои плейлисты</button>
    </div>
  );
}

export default function PlaylistsTab({ onPlayTrack, downloadsInProgress, currentTrack, isPlaying, onPlayPause, query, setQuery }) {
  const [mode, setMode] = useState('search'); // 'search' (SoundCloud) | 'mine' (local)
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null); // { playlist, tracks }
  const [playlistLoading, setPlaylistLoading] = useState(false);
  const lastSearchedRef = useRef('');

  // Auto-search on query change
  useEffect(() => {
    if (!query.trim()) {
      setPlaylists([]);
      setError(null);
      lastSearchedRef.current = '';
      return;
    }
    const timer = setTimeout(() => performSearch(query), 500);
    return () => clearTimeout(timer);
  }, [query]);

  const performSearch = async (q) => {
    const trimmed = q.trim();
    if (!trimmed || trimmed === lastSearchedRef.current) return;
    lastSearchedRef.current = trimmed;
    setLoading(true);
    setError(null);
    setSelectedPlaylist(null);
    try {
      const data = await window.api.searchPlaylists(trimmed);
      setPlaylists(data?.collection || []);
    } catch (e) {
      setError('Ошибка поиска плейлистов. Проверьте подключение.');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    if (e) e.preventDefault();
    performSearch(query);
  };

  const openPlaylist = async (playlist) => {
    setPlaylistLoading(true);
    try {
      const full = await window.api.getPlaylist(playlist.id);
      setSelectedPlaylist({ meta: full, tracks: full.tracks || [] });
    } catch (e) {
      alert('Не удалось загрузить плейлист.');
    } finally {
      setPlaylistLoading(false);
    }
  };

  const handleDownload = useCallback((track) => {
    if (!track.media?.transcodings?.length) return;
    const url = track.artwork_url || track.user?.avatar_url || '';
    const coverUrl = getHighResCover(url);
    window.api.downloadTrack({
      trackId: track.id.toString(),
      title: track.title,
      artist: track.user?.username || 'Unknown',
      artworkUrl: coverUrl,
      transcodings: track.media.transcodings,
      duration: track.duration
    });
  }, []);

  const playAllTracks = () => {
    if (!selectedPlaylist?.tracks?.length) return;
    const validTracks = selectedPlaylist.tracks.filter(t => t.media?.transcodings?.length);
    if (!validTracks.length) { alert('В этом плейлисте нет доступных треков для воспроизведения.'); return; }
    onPlayTrack(validTracks[0], validTracks);
  };

  // My (local) playlists mode
  if (mode === 'mine') {
    return (
      <div>
        <div className="search-header">
          <h1>Плейлисты</h1>
          <ModeTabs mode={mode} setMode={setMode} />
        </div>
        <MyPlaylistsView
          onPlayTrack={onPlayTrack}
          currentTrack={currentTrack}
          isPlaying={isPlaying}
          onPlayPause={onPlayPause}
          downloadsInProgress={downloadsInProgress}
        />
      </div>
    );
  }

  // Playlist detail view
  if (selectedPlaylist) {
    const { meta, tracks } = selectedPlaylist;
    const cover = getHighResCover(meta.artwork_url || tracks[0]?.artwork_url);
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px' }}>
          <button
            onClick={() => setSelectedPlaylist(null)}
            style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '6px 10px', borderRadius: '8px', transition: 'background 0.15s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.06)'}
            onMouseLeave={e => e.currentTarget.style.background = 'none' }
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
            Назад
          </button>
        </div>

        {/* Playlist header */}
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-end', marginBottom: '28px' }}>
          <img
            src={cover}
            alt={meta.title}
            style={{ width: '140px', height: '140px', borderRadius: '12px', objectFit: 'cover', flexShrink: 0, boxShadow: '0 8px 32px rgba(0,0,0,0.5)' }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--accent-color)', marginBottom: '6px' }}>Плейлист</div>
            <h1 style={{ margin: '0 0 8px', fontSize: 'clamp(18px, 3vw, 28px)', lineHeight: 1.2, wordBreak: 'break-word' }}>{meta.title}</h1>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              {meta.user?.username} &bull; {tracks.length} треков
            </div>
            <button
              onClick={playAllTracks}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '10px 22px', background: 'var(--accent-gradient)', border: 'none', borderRadius: '30px', color: '#fff', fontWeight: '700', fontSize: '14px', cursor: 'pointer', boxShadow: '0 4px 16px var(--accent-glow)' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
              Слушать всё
            </button>
          </div>
        </div>

        {/* Track list */}
        <div className="offline-list">
          {tracks.map((track, idx) => {
            if (!track || !track.id) return null;
            const isCurrent = !!(currentTrack && (currentTrack.id === track.id || currentTrack.trackId === track.id?.toString()));
            const showPause = isCurrent && isPlaying;
            const isDownloading = !!downloadsInProgress[track.id?.toString()];
            return (
              <PlaylistTrackRow
                key={track.id}
                track={track}
                index={idx}
                isCurrent={isCurrent}
                showPause={showPause}
                isDownloading={isDownloading}
                onPlay={() => {
                  if (isCurrent) {
                    onPlayPause();
                  } else {
                    const validTracks = tracks.filter(t => t.media?.transcodings?.length);
                    onPlayTrack(track, validTracks);
                  }
                }}
                onDownload={() => handleDownload(track)}
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="search-header">
        <h1>Плейлисты</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <ModeTabs mode={mode} setMode={setMode} />
          <form onSubmit={handleSearch} className="search-input-wrapper" style={{ width: '320px' }}>
            <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              className="search-input"
              placeholder="Название плейлиста, исполнитель..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </form>
        </div>
      </div>

      {(loading || playlistLoading) && (
        <div className="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s linear infinite' }}>
            <line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/>
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/>
            <line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/>
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>
          </svg>
          <span className="empty-state-title">{playlistLoading ? 'Загрузка плейлиста...' : 'Поиск плейлистов...'}</span>
        </div>
      )}

      {error && (
        <div className="empty-state" style={{ color: '#f87171' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <span className="empty-state-title">{error}</span>
        </div>
      )}

      {!loading && !error && playlists.length === 0 && (
        <div className="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"/>
            <line x1="8" y1="12" x2="21" y2="12"/>
            <line x1="8" y1="18" x2="21" y2="18"/>
            <line x1="3" y1="6" x2="3.01" y2="6"/>
            <line x1="3" y1="12" x2="3.01" y2="12"/>
            <line x1="3" y1="18" x2="3.01" y2="18"/>
          </svg>
          <span className="empty-state-title">Введите поисковый запрос для поиска плейлистов</span>
        </div>
      )}

      {!loading && !error && playlists.length > 0 && (
        <div className="track-grid">
          {playlists.map((pl) => (
            <PlaylistCard key={pl.id} playlist={pl} onClick={() => openPlaylist(pl)} />
          ))}
        </div>
      )}
    </div>
  );
}
