import React, { useState, useEffect, useRef, useCallback, memo } from 'react';
import AddToPlaylist from './AddToPlaylist.jsx';

// Memoized card prevents re-renders when only isPlaying/currentTrack change in the parent
const TrackCard = memo(function TrackCard({ track, isCurrent, showPause, isDownloading, onPlay, onDownload }) {
  const coverUrl = (() => {
    const url = track.artwork_url || track.user?.avatar_url;
    if (!url) return 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';
    return url.replace('http://', 'https://').replace('-large.jpg', '-t500x500.jpg');
  })();

  const playlistTrack = {
    trackId: String(track.id),
    title: track.title,
    artist: track.user?.username || 'Unknown',
    artworkUrl: coverUrl,
    transcodings: track.media?.transcodings || [],
    duration: track.duration
  };

  return (
    <div className="track-card">
      <div className="card-cover-container">
        <img className="card-cover" src={coverUrl} alt={track.title} />
        <div className="card-play-overlay">
          <button className="overlay-play-btn" onClick={onPlay}>
            {showPause ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#000000' }}>
                <rect x="6" y="4" width="4" height="16" />
                <rect x="14" y="4" width="4" height="16" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" style={{ color: '#000000', marginLeft: '2px' }}>
                <polygon points="5 3 19 12 5 21 5 3" />
              </svg>
            )}
          </button>
        </div>
      </div>

      <button
        className="download-action-btn"
        onClick={onDownload}
        disabled={!!isDownloading}
        title="Скачать трек"
        style={isDownloading ? { background: '#ffffff', color: '#000000', opacity: 1, transform: 'scale(1)' } : {}}
      >
        {isDownloading ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s linear infinite' }}>
            <line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" /><line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" /><line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
      </button>

      <AddToPlaylist track={playlistTrack} variant="card" />

      <div className="card-title" title={track.title}>{track.title}</div>
      <div className="card-artist" title={track.user?.username}>{track.user?.username}</div>
    </div>
  );
});

export default function SearchTab({ onPlayTrack, downloadsInProgress, currentTrack, isPlaying, onPlayPause, query, setQuery, tracks, setTracks }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const lastSearchedRef = useRef(tracks && tracks.length > 0 ? query.trim() : '');

  const performSearch = async (searchQuery) => {
    const trimmed = searchQuery.trim();
    if (!trimmed || trimmed === lastSearchedRef.current) return;
    lastSearchedRef.current = trimmed;

    setLoading(true);
    setError(null);
    try {
      const data = await window.api.searchTracks(trimmed);
      if (data && data.collection) {
        setTracks(data.collection);
      } else {
        setTracks([]);
      }
    } catch (err) {
      console.error(err);
      setError('Ошибка поиска. Проверьте подключение к Интернету.');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    if (e) e.preventDefault();
    performSearch(query);
  };

  useEffect(() => {
    if (!query.trim()) {
      setTracks([]);
      setError(null);
      lastSearchedRef.current = '';
      return;
    }

    const timer = setTimeout(() => {
      performSearch(query);
    }, 500);

    return () => clearTimeout(timer);
  }, [query]);

  const getHighResCover = useCallback((track) => {
    const url = track.artwork_url || track.user?.avatar_url;
    if (!url) return 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';
    return url.replace('http://', 'https://').replace('-large.jpg', '-t500x500.jpg');
  }, []);

  const handleDownload = useCallback((track) => {
    if (!track.media?.transcodings?.length) return;
    window.api.downloadTrack({
      trackId: track.id.toString(),
      title: track.title,
      artist: track.user?.username || 'Unknown',
      artworkUrl: getHighResCover(track),
      transcodings: track.media.transcodings,
      duration: track.duration
    });
  }, [getHighResCover]);

  return (
    <div>
      <div className="search-header">
        <h1>Поиск музыки</h1>
        <form onSubmit={handleSearch} className="search-input-wrapper">
          <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
          <input
            type="text"
            className="search-input"
            placeholder="Исполнитель, трек, жанр..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      </div>

      {loading && (
        <div className="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1.5s linear infinite' }}>
            <line x1="12" y1="2" x2="12" y2="6" />
            <line x1="12" y1="18" x2="12" y2="22" />
            <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
            <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
            <line x1="2" y1="12" x2="6" y2="12" />
            <line x1="18" y1="12" x2="22" y2="12" />
            <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
            <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
          </svg>
          <span className="empty-state-title">Поиск треков на SoundCloud...</span>
        </div>
      )}

      {error && (
        <div className="empty-state" style={{ color: '#f87171' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          <span className="empty-state-title">{error}</span>
        </div>
      )}

      {!loading && !error && tracks.length === 0 && (
        <div className="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13"></path>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="16" r="3"></circle>
          </svg>
          <span className="empty-state-title">Введите поисковый запрос выше, чтобы найти музыку</span>
        </div>
      )}

      {!loading && !error && tracks.length > 0 && (
        <div className="track-grid">
          {tracks.map((track) => {
            const isDownloading = !!downloadsInProgress[track.id.toString()];
            const isCurrent = !!(currentTrack && (currentTrack.id === track.id || currentTrack.trackId === track.id.toString()));
            const showPause = isCurrent && isPlaying;
            return (
              <TrackCard
                key={track.id}
                track={track}
                isCurrent={isCurrent}
                showPause={showPause}
                isDownloading={isDownloading}
                onPlay={() => isCurrent ? onPlayPause() : onPlayTrack(track)}
                onDownload={() => handleDownload(track)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
