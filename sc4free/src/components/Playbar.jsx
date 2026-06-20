import React, { useState, useEffect, useRef, useCallback } from 'react';

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(sec) {
  if (!isFinite(sec) || isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

function getCoverUrl(track) {
  if (!track) return null;
  if (track.coverPath) {
    return `media://path/${encodeURIComponent(track.coverPath.replace(/\\/g, '/'))}`;
  }
  const raw = track.artwork_url || track.user?.avatar_url;
  if (raw) return raw.replace('http://', 'https://').replace('-large.jpg', '-t500x500.jpg');
  return 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png';
}

// ─── Slider ──────────────────────────────────────────────────────────────────
// While dragging, a local `dragPct` is the single source of truth for the
// thumb/fill position. Incoming `value` updates (e.g. playback timeupdates a few
// times per second) still re-render the component, but they no longer fight the
// drag — previously the inline style was recomputed from the live `value` on
// every render and snapped the thumb back to the playback position mid-drag.

function Slider({ value, max, onChange, onSeekStart, onSeekEnd, className = '' }) {
  const rootRef = useRef(null);
  const dragging = useRef(false);
  const [dragPct, setDragPct] = useState(null); // 0..100 while dragging, else null

  const externalPct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const pct = dragPct !== null ? dragPct : externalPct;

  const getRatio = useCallback((e) => {
    const root = rootRef.current;
    if (!root) return 0;
    const rect = root.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }, []);

  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    dragging.current = true;
    rootRef.current?.setPointerCapture?.(e.pointerId);
    onSeekStart?.();
    const ratio = getRatio(e);
    setDragPct(ratio * 100);
    onChange(ratio * max);
  }, [getRatio, onChange, onSeekStart, max]);

  const handlePointerMove = useCallback((e) => {
    if (!dragging.current) return;
    const ratio = getRatio(e);
    setDragPct(ratio * 100);
    onChange(ratio * max);
  }, [getRatio, onChange, max]);

  const handlePointerUp = useCallback((e) => {
    if (!dragging.current) return;
    dragging.current = false;
    const ratio = getRatio(e);
    setDragPct(null);
    const val = ratio * max;
    onChange(val);
    onSeekEnd?.(val);
  }, [getRatio, onChange, onSeekEnd, max]);

  return (
    <div
      ref={rootRef}
      className={`pb2-slider ${className}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <div className="pb2-slider-rail" />
      <div className="pb2-slider-fill"  style={{ width: `${pct}%` }} />
      <div className="pb2-slider-thumb" style={{ left:  `${pct}%` }} />
    </div>
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

const IconShuffle = ({ active }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke={active ? '#fff' : 'currentColor'} strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 3 21 3 21 8" />
    <line x1="4" y1="20" x2="21" y2="3" />
    <polyline points="21 16 21 21 16 21" />
    <line x1="15" y1="15" x2="21" y2="21" />
    <line x1="4" y1="4" x2="9" y2="9" />
  </svg>
);

const IconPrev = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="19 20 9 12 19 4 19 20" />
    <rect x="5" y="4" width="2" height="16" />
  </svg>
);

const IconNext = () => (
  <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 4 15 12 5 20 5 4" />
    <rect x="17" y="4" width="2" height="16" />
  </svg>
);

const IconPlay = ({ size = 19 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const IconPause = ({ size = 19 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);

const IconRepeat = ({ mode }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
    stroke={mode !== 'none' ? '#fff' : 'currentColor'} strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round">
    <polyline points="17 1 21 5 17 9" />
    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
    <polyline points="7 23 3 19 7 15" />
    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
    {mode === 'one' && (
      <text x="10.5" y="14" fontSize="7" fontWeight="900"
        fill={mode !== 'none' ? '#fff' : 'currentColor'} stroke="none"
        textAnchor="middle">1</text>
    )}
  </svg>
);

const IconVolumeMuted = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);

const IconVolumeLow = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

const IconVolumeHigh = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

// ─── Seek row ─────────────────────────────────────────────────────────────────
// `seekVal` holds the target time while the user is dragging so the left label
// previews where the playhead will land; otherwise it mirrors live playback.

function SeekRow({ currentTime, duration, onSeek }) {
  const [seekVal, setSeekVal] = useState(null); // seconds while seeking, else null
  const display = seekVal !== null ? seekVal : currentTime;

  return (
    <div className="pb2-seek-row">
      <span className="pb2-time">{formatTime(display)}</span>
      <Slider
        value={currentTime}
        max={duration || 0}
        onChange={(val) => setSeekVal(val)}
        onSeekStart={() => setSeekVal(currentTime)}
        onSeekEnd={(val) => { setSeekVal(null); onSeek(val); }}
        className="pb2-seek-slider"
      />
      <span className="pb2-time pb2-time-right">{formatTime(duration)}</span>
    </div>
  );
}

// ─── Main Playbar ────────────────────────────────────────────────────────────

export default function Playbar({
  track,
  isPlaying,
  onPlayPause,
  onNext,
  onPrevious,
  currentTime,
  duration,
  onSeek,
  volume,
  onVolumeChange,
  shuffleMode,
  onToggleShuffle,
  repeatMode,
  onToggleRepeat,
}) {
  const prevVolume = useRef(volume > 0 ? volume : 0.8);

  useEffect(() => {
    if (volume > 0) prevVolume.current = volume;
  }, [volume]);

  const handleMuteToggle = useCallback(() => {
    if (volume > 0) {
      prevVolume.current = volume;
      onVolumeChange(0);
    } else {
      onVolumeChange(prevVolume.current || 0.8);
    }
  }, [volume, onVolumeChange]);

  const VolumeIcon = volume === 0 ? IconVolumeMuted : volume < 0.5 ? IconVolumeLow : IconVolumeHigh;

  if (!track) {
    return (
      <div className="pb2-bar pb2-empty">
        <span>Выберите трек для воспроизведения</span>
      </div>
    );
  }

  const coverUrl   = getCoverUrl(track);
  const artistName = track.artist || track.user?.username || 'Неизвестный исполнитель';

  return (
    <div className="pb2-bar">
      {/* LEFT */}
      <div className="pb2-track-info">
        <img className="pb2-cover" src={coverUrl} alt={track.title} />
        <div className="pb2-meta">
          <div className="pb2-title"  title={track.title}>{track.title}</div>
          <div className="pb2-artist" title={artistName}>{artistName}</div>
        </div>
      </div>

      {/* CENTER */}
      <div className="pb2-center">
        <div className="pb2-buttons">
          <button
            className={`pb2-ctrl-btn ${shuffleMode ? 'pb2-ctrl-active' : ''}`}
            onClick={onToggleShuffle}
            title="Случайный порядок"
          >
            <IconShuffle active={shuffleMode} />
          </button>

          <button className="pb2-ctrl-btn" onClick={onPrevious} title="Предыдущий трек">
            <IconPrev />
          </button>

          <button className="pb2-play-btn" onClick={onPlayPause}
            title={isPlaying ? 'Пауза' : 'Воспроизведение'}>
            {isPlaying ? <IconPause /> : <IconPlay />}
          </button>

          <button className="pb2-ctrl-btn" onClick={onNext} title="Следующий трек">
            <IconNext />
          </button>

          <button
            className={`pb2-ctrl-btn ${repeatMode !== 'none' ? 'pb2-ctrl-active' : ''}`}
            onClick={onToggleRepeat}
            title={repeatMode === 'one' ? 'Повтор: 1 трек' : repeatMode === 'all' ? 'Повтор: всё' : 'Повтор: выкл'}
          >
            <IconRepeat mode={repeatMode} />
          </button>
        </div>

        <SeekRow currentTime={currentTime} duration={duration} onSeek={onSeek} />
      </div>

      {/* RIGHT */}
      <div className="pb2-right">
        <button className="pb2-ctrl-btn" onClick={handleMuteToggle}
          title={volume === 0 ? 'Включить звук' : 'Выключить звук'}>
          <VolumeIcon />
        </button>
        <Slider
          value={volume}
          max={1}
          onChange={onVolumeChange}
          className="pb2-vol-slider"
        />
      </div>
    </div>
  );
}

// ─── Exports for reuse ───────────────────────────────────────────────────────
export { Slider, IconPlay, IconPause, getCoverUrl, formatTime };
