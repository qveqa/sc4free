import React, { useEffect, useState } from 'react';
import { getCoverUrl } from './Playbar.jsx';
import AddToPlaylist from './AddToPlaylist.jsx';

export default function DownloadsTab({
  downloadsInProgress,
  onPlayOfflineTrack,
  // These come from App to show current playback state in the list
  currentTrack,
  isPlaying,
  onPlayPause,
}) {
  const [downloads, setDownloads] = useState([]);
  const [loading, setLoading]     = useState(true);

  const fetchDownloads = async () => {
    try {
      const list = await window.api.getDownloads();
      setDownloads(list);
    } catch (e) {
      console.error('Failed to fetch downloads:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchDownloads(); }, []);

  useEffect(() => {
    const hasActive = Object.values(downloadsInProgress).some(
      item => item.status !== 'completed' && item.status !== 'failed'
    );
    let iv;
    if (hasActive) {
      iv = setInterval(fetchDownloads, 2000);
    } else {
      fetchDownloads();
    }
    return () => { if (iv) clearInterval(iv); };
  }, [downloadsInProgress]);

  const handleDelete = async (e, trackId) => {
    e.stopPropagation();
    if (confirm('Вы уверены, что хотите удалить этот трек из памяти?')) {
      const ok = await window.api.deleteDownload(trackId);
      if (ok) fetchDownloads();
      else alert('Не удалось удалить файл.');
    }
  };

  const getMediaUrl = (filePath) => {
    if (!filePath) return '';
    return `media://path/${encodeURIComponent(filePath.replace(/\\/g, '/'))}`;
  };

  const getStatusText = (s) => ({
    queued: 'В очереди', downloading: 'Скачивание', transcoding: 'Обработка',
    tagging: 'Тегирование', completed: 'Готово', failed: 'Ошибка', cancelled: 'Отменено'
  }[s] || s);

  const handleCancel = async (e, trackId) => {
    e.stopPropagation();
    await window.api.cancelDownloadTask(trackId);
  };

  const activeDownloads = Object.values(downloadsInProgress).filter(
    item => item.status !== 'completed'
  );

  const isCurrentTrack = (item) =>
    currentTrack && (currentTrack.id === item.id || currentTrack.trackId === item.id);

  return (
    <div>
      <h1>Локальная библиотека</h1>

      {/* Active downloads queue */}
      {activeDownloads.length > 0 && (
        <div className="download-hud glass-panel" style={{ marginTop: '20px', background: 'rgba(255,255,255,0.03)' }}>
          <h2 className="hud-title" style={{ color: 'var(--accent-color)' }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ animation: 'spin 2s linear infinite' }}>
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
            Загрузки в процессе
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {activeDownloads.map((item) => (
              <div key={item.trackId} className="download-item-row">
                <div className="download-item-meta">
                  <div className="download-item-text" title={`${item.artist} — ${item.title}`}>
                    <strong>{item.artist}</strong> — {item.title}
                  </div>
                </div>
                <div className="download-item-status-container">
                  {item.status === 'downloading' && (
                    <div className="download-progress-bar-container">
                      <div className="download-progress-bar-fill" style={{ width: `${item.progress}%` }} />
                    </div>
                  )}
                  {item.status === 'downloading' && (
                    <span className="download-percentage">{item.progress}%</span>
                  )}
                  <span className={`status-badge ${item.status}`}>{getStatusText(item.status)}</span>
                  {(item.status === 'downloading' || item.status === 'transcoding' || item.status === 'queued') && (
                    <button
                      className="cancel-download-btn"
                      onClick={(e) => handleCancel(e, item.trackId)}
                      title="Отменить загрузку"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Offline library list */}
      <h2 style={{ marginTop: '30px', fontSize: '18px', fontWeight: '600' }}>
        Скачанные треки ({downloads.length})
      </h2>

      {loading && (
        <div className="empty-state">
          <span className="empty-state-title">Загрузка библиотеки...</span>
        </div>
      )}

      {!loading && downloads.length === 0 && (
        <div className="empty-state" style={{ marginTop: '20px' }}>
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          <span className="empty-state-title">Нет скачанных файлов</span>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Перейдите во вкладку «Поиск», найдите трек и нажмите на кнопку скачивания.
          </p>
        </div>
      )}

      {!loading && downloads.length > 0 && (
        <div className="offline-list">
          {downloads.map((item) => {
            const active = isCurrentTrack(item);
            const cover  = item.coverPath
              ? getMediaUrl(item.coverPath)
              : 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';

            return (
              <div
                key={item.id}
                className={`offline-row${active ? ' offline-row--active' : ''}`}
                onClick={() => {
                  if (active) {
                    onPlayPause?.();
                  } else {
                    onPlayOfflineTrack(item, downloads);
                  }
                }}
              >
                {/* Cover + play indicator */}
                <div className="offline-track-info">
                  <div className="offline-cover-wrap">
                    <img className="offline-cover" src={cover} alt={item.title} />
                    <div className={`offline-play-overlay${active ? ' offline-play-overlay--visible' : ''}`}>
                      {active && isPlaying
                        ? <PauseIcon />
                        : <PlayIcon />
                      }
                    </div>
                  </div>

                  <div className="offline-text">
                    <span className={`offline-title${active ? ' offline-title--active' : ''}`}>
                      {item.title}
                    </span>
                    <span className="offline-artist">{item.artist}</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="offline-actions" onClick={(e) => e.stopPropagation()}>
                  {active && (
                    <span className="offline-now-playing-badge">
                      <NowPlayingBars animate={isPlaying} />
                    </span>
                  )}
                  <AddToPlaylist
                    track={{
                      trackId: String(item.id),
                      title: item.title,
                      artist: item.artist,
                      artworkUrl: '',
                      transcodings: [],
                      duration: item.duration
                    }}
                    variant="row"
                  />
                  <button
                    className="delete-btn"
                    onClick={(e) => handleDelete(e, item.id)}
                    title="Удалить файл"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      <line x1="10" y1="11" x2="10" y2="17" />
                      <line x1="14" y1="11" x2="14" y2="17" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}

function NowPlayingBars({ animate }) {
  return (
    <span className={`npb${animate ? ' npb--playing' : ''}`}>
      <span className="npb-bar" />
      <span className="npb-bar" />
      <span className="npb-bar" />
    </span>
  );
}
