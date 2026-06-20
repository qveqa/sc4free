import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';

const POPOVER_WIDTH = 240;
const POPOVER_HEIGHT = 330;

// Reusable "+" button that opens a popover to add `track` to one of the user's
// local playlists (or create a new one inline). `track` must be normalized to:
//   { trackId, title, artist, artworkUrl, transcodings, duration }
export default function AddToPlaylist({ track, variant = 'row' }) {
  const btnRef = useRef(null);
  const popRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [flash, setFlash] = useState(null); // { id, text }

  const computePos = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    let left = b.right - POPOVER_WIDTH;
    left = Math.max(8, Math.min(left, window.innerWidth - POPOVER_WIDTH - 8));
    let top = b.bottom + 6;
    if (top + POPOVER_HEIGHT > window.innerHeight - 8 && b.top - 6 - POPOVER_HEIGHT > 8) {
      top = b.top - 6 - POPOVER_HEIGHT; // flip above when no room below
    }
    setPos({ top, left });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const lists = await window.api.getUserPlaylists();
      setPlaylists(lists || []);
    } catch (e) {
      console.error('Failed to load playlists:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const toggle = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (open) { setOpen(false); return; }
    computePos();
    setFlash(null);
    setNewName('');
    setOpen(true);
    load();
  }, [open, computePos, load]);

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    const reposition = () => computePos();
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, computePos]);

  const addTo = useCallback(async (pl) => {
    if (!track?.trackId) return;
    setBusyId(pl.id);
    try {
      const res = await window.api.addTrackToPlaylist(pl.id, track);
      setFlash({ id: pl.id, text: res?.added ? 'Добавлено' : 'Уже есть' });
      if (res?.added) {
        setPlaylists((prev) => prev.map((p) =>
          p.id === pl.id ? { ...p, track_count: (p.track_count || 0) + 1 } : p));
      }
      setTimeout(() => { setOpen(false); setFlash(null); }, 650);
    } catch (e) {
      console.error('Failed to add track:', e);
    } finally {
      setBusyId(null);
    }
  }, [track]);

  const createAndAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name || !track?.trackId) return;
    try {
      const pl = await window.api.createPlaylist(name);
      if (pl) {
        await window.api.addTrackToPlaylist(pl.id, track);
        setNewName('');
        setFlash({ id: pl.id, text: 'Создано' });
        setTimeout(() => { setOpen(false); setFlash(null); }, 700);
      }
    } catch (e) {
      console.error('Failed to create playlist:', e);
    }
  }, [newName, track]);

  return (
    <>
      <button
        ref={btnRef}
        className={`add-to-pl-btn add-to-pl-btn--${variant}${open ? ' add-to-pl-btn--open' : ''}`}
        onClick={toggle}
        title="Добавить в плейлист"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="atp-popover"
          style={{ top: pos.top, left: pos.left, width: POPOVER_WIDTH }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="atp-header">Добавить в плейлист</div>

          <div className="atp-list">
            {loading && <div className="atp-empty">Загрузка...</div>}
            {!loading && playlists.length === 0 && (
              <div className="atp-empty">Пока нет плейлистов</div>
            )}
            {!loading && playlists.map((pl) => (
              <button
                key={pl.id}
                className="atp-item"
                onClick={() => addTo(pl)}
                disabled={busyId === pl.id}
              >
                <span className="atp-item-name" title={pl.name}>{pl.name}</span>
                {flash && flash.id === pl.id
                  ? <span className="atp-item-flash">{flash.text}</span>
                  : <span className="atp-item-count">{pl.track_count}</span>}
              </button>
            ))}
          </div>

          <div className="atp-create">
            <input
              className="atp-create-input"
              placeholder="Новый плейлист..."
              value={newName}
              maxLength={120}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createAndAdd(); }}
            />
            <button
              className="atp-create-btn"
              onClick={createAndAdd}
              disabled={!newName.trim()}
              title="Создать и добавить"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
