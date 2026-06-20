import React, { useState, useEffect, useCallback } from 'react';
import { getCoverUrl, formatTime } from './Playbar.jsx';

const PLACEHOLDER = 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';

function playlistCover(pl) {
  if (pl.coverPath) return `media://path/${encodeURIComponent(pl.coverPath.replace(/\\/g, '/'))}`;
  if (pl.cover_url) return pl.cover_url.replace('http://', 'https://').replace('-large.jpg', '-t500x500.jpg');
  return PLACEHOLDER;
}

export default function MyPlaylistsView({ onPlayTrack, currentTrack, isPlaying, onPlayPause, downloadsInProgress }) {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // { meta, tracks }
  const [detailLoading, setDetailLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [renaming, setRenaming] = useState(null); // { id, value }

  const fetchPlaylists = useCallback(async () => {
    try {
      const lists = await window.api.getUserPlaylists();
      setPlaylists(lists || []);
    } catch (e) {
      console.error('Failed to load playlists:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchPlaylists(); }, [fetchPlaylists]);

  const openPlaylist = useCallback(async (pl) => {
    setDetailLoading(true);
    try {
      const data = await window.api.getUserPlaylistTracks(pl.id);
      setSelected({ meta: data.meta || pl, tracks: data.tracks || [] });
    } catch (e) {
      console.error('Failed to open playlist:', e);
      alert('Не удалось загрузить плейлист.');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const refreshDetail = useCallback(async (playlistId) => {
    const data = await window.api.getUserPlaylistTracks(playlistId);
    setSelected((prev) => prev ? { ...prev, tracks: data.tracks || [] } : prev);
  }, []);

  const handleCreate = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    const pl = await window.api.createPlaylist(name);
    setNewName('');
    if (pl) fetchPlaylists();
  }, [newName, fetchPlaylists]);

  const handleDelete = useCallback(async (e, pl) => {
    e.stopPropagation();
    if (!confirm(`Удалить плейлист «${pl.name}»? Треки внутри будут удалены из плейлиста (файлы не затрагиваются).`)) return;
    await window.api.deletePlaylist(pl.id);
    fetchPlaylists();
  }, [fetchPlaylists]);

  const startRename = useCallback((e, pl) => {
    e.stopPropagation();
    setRenaming({ id: pl.id, value: pl.name });
  }, []);

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const id = renaming.id;
    const trimmed = renaming.value.trim();
    setRenaming(null);
    if (!trimmed) return;
    await window.api.renamePlaylist(id, trimmed);
    fetchPlaylists();
    setSelected((prev) => prev && prev.meta.id === id
      ? { ...prev, meta: { ...prev.meta, name: trimmed } } : prev);
  }, [renaming, fetchPlaylists]);

  const playableTracks = useCallback((tracks) =>
    tracks.filter((t) => t.filePath || t.media?.transcodings?.length), []);

  const playAll = useCallback(() => {
    if (!selected) return;
    const valid = playableTracks(selected.tracks);
    if (!valid.length) { alert('В этом плейлисте нет доступных для воспроизведения треков.'); return; }
    onPlayTrack(valid[0], valid);
  }, [selected, onPlayTrack, playableTracks]);

  const removeTrack = useCallback(async (e, playlistId, trackId) => {
    e.stopPropagation();
    await window.api.removeTrackFromPlaylist(playlistId, trackId);
    refreshDetail(playlistId);
    fetchPlaylists();
  }, [refreshDetail, fetchPlaylists]);

  // ─── Detail view ────────────────────────────────────────────────────────────
  if (selected) {
    const { meta, tracks } = selected;
    const cover = tracks.length ? getCoverUrl(tracks[0]) : PLACEHOLDER;
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
          <button
            onClick={() => setSelected(null)}
            className="mpl-back-btn"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Назад
          </button>
        </div>

        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-end', marginBottom: '28px' }}>
          <img src={cover} alt={meta.name} className="mpl-detail-cover" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '1px', color: 'var(--accent-color)', marginBottom: '6px' }}>Мой плейлист</div>
            {renaming && renaming.id === meta.id ? (
              <input
                className="atp-create-input mpl-rename-input"
                autoFocus
                value={renaming.value}
                maxLength={120}
                onChange={(e) => setRenaming((r) => ({ ...r, value: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }}
                onBlur={commitRename}
              />
            ) : (
              <h1 style={{ margin: '0 0 8px', fontSize: 'clamp(18px, 3vw, 28px)', lineHeight: 1.2, wordBreak: 'break-word' }}>{meta.name}</h1>
            )}
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
              {tracks.length} {tracks.length === 1 ? 'трек' : 'треков'}
            </div>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={playAll} className="mpl-play-all-btn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3" /></svg>
                Слушать всё
              </button>
              <button onClick={(e) => startRename(e, meta)} className="mpl-ghost-btn" title="Переименовать">Переименовать</button>
            </div>
          </div>
        </div>

        {tracks.length === 0 && (
          <div className="empty-state" style={{ marginTop: '20px' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
            </svg>
            <span className="empty-state-title">Плейлист пуст</span>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              Добавляйте треки кнопкой «+» в Поиске, Загрузках или плейлистах SoundCloud.
            </p>
          </div>
        )}

        <div className="offline-list">
          {tracks.map((track) => {
            const isCurrent = !!(currentTrack && (currentTrack.id === track.id || currentTrack.trackId === track.trackId));
            const showPause = isCurrent && isPlaying;
            const cover = getCoverUrl(track);
            const playable = track.filePath || track.media?.transcodings?.length;
            const dur = track.duration ? formatTime(track.duration / 1000) : '--:--';
            return (
              <div
                key={track.trackId}
                className={`offline-row${isCurrent ? ' offline-row--active' : ''}`}
                style={{ cursor: playable ? 'pointer' : 'default', opacity: playable ? 1 : 0.5 }}
                onClick={() => {
                  if (!playable) return;
                  if (isCurrent) onPlayPause();
                  else onPlayTrack(track, playableTracks(tracks));
                }}
              >
                <div className="offline-track-info">
                  <div className="offline-cover-wrap">
                    <img className="offline-cover" src={cover} alt={track.title} />
                    <div className={`offline-play-overlay${isCurrent ? ' offline-play-overlay--visible' : ''}`}>
                      {showPause
                        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><polygon points="5 3 19 12 5 21 5 3" /></svg>}
                    </div>
                  </div>
                  <div className="offline-text">
                    <span className={`offline-title${isCurrent ? ' offline-title--active' : ''}`}>{track.title}</span>
                    <span className="offline-artist">{track.artist}{track.filePath ? ' • скачан' : ''}</span>
                  </div>
                </div>
                <div className="offline-actions" onClick={(e) => e.stopPropagation()}>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)', marginRight: '4px' }}>{dur}</span>
                  <button
                    className="delete-btn"
                    onClick={(e) => removeTrack(e, meta.id, track.trackId)}
                    title="Убрать из плейлиста"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ─── List view ──────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="mpl-create-bar">
        <input
          className="search-input mpl-create-input"
          placeholder="Название нового плейлиста..."
          value={newName}
          maxLength={120}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); }}
        />
        <button className="mpl-create-btn" onClick={handleCreate} disabled={!newName.trim()}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Создать
        </button>
      </div>

      {loading && (
        <div className="empty-state"><span className="empty-state-title">Загрузка...</span></div>
      )}

      {!loading && playlists.length === 0 && (
        <div className="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" />
          </svg>
          <span className="empty-state-title">У вас пока нет плейлистов</span>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
            Создайте плейлист выше, затем добавляйте треки кнопкой «+».
          </p>
        </div>
      )}

      {!loading && playlists.length > 0 && (
        <div className="track-grid">
          {playlists.map((pl) => (
            <div key={pl.id} className="track-card playlist-card" style={{ cursor: 'pointer' }} onClick={() => openPlaylist(pl)}>
              <div className="card-cover-container">
                <img className="card-cover" src={playlistCover(pl)} alt={pl.name} />
                <div className="playlist-card-count">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></svg>
                  {pl.track_count} треков
                </div>
              </div>
              <div className="mpl-card-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  {renaming && renaming.id === pl.id ? (
                    <input
                      className="atp-create-input"
                      autoFocus
                      value={renaming.value}
                      maxLength={120}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming((r) => ({ ...r, value: e.target.value }))}
                      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') cancelRename(); }}
                      onBlur={commitRename}
                    />
                  ) : (
                    <>
                      <div className="card-title" title={pl.name}>{pl.name}</div>
                      <div className="card-artist">Локальный плейлист</div>
                    </>
                  )}
                </div>
                <div className="mpl-card-actions">
                  <button className="mpl-icon-btn" onClick={(e) => startRename(e, pl)} title="Переименовать">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                    </svg>
                  </button>
                  <button className="mpl-icon-btn mpl-icon-btn--danger" onClick={(e) => handleDelete(e, pl)} title="Удалить плейлист">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {detailLoading && (
        <div className="empty-state"><span className="empty-state-title">Загрузка плейлиста...</span></div>
      )}
    </div>
  );
}
