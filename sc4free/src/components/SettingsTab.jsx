import React, { useState } from 'react';

export default function SettingsTab({ settings, onUpdateSettings, userProfile, onLogout }) {
  const [manualToken, setManualToken] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSelectFolder = async () => {
    try {
      const newPath = await window.api.selectDownloadDir();
      if (newPath) {
        onUpdateSettings({ downloadDirectory: newPath });
      }
    } catch (e) {
      console.error(e);
      alert('Не удалось изменить папку.');
    }
  };

  const handleClearCache = () => {
    if (confirm('Вы хотите сбросить сохраненные настройки и кэш авторизации? (Скачанные файлы останутся на диске)')) {
      onUpdateSettings({
        volume: 0.8,
        repeatMode: 'none',
        shuffleMode: false
      });
      window.api.logout();
      alert('Настройки сброшены.');
    }
  };

  const handleLogin = async () => {
    try {
      await window.api.openAuthWindow();
    } catch (e) {
      console.error(e);
    }
  };

  const handleManualSubmit = async (e) => {
    e.preventDefault();
    if (!manualToken.trim()) return;

    setLoading(true);
    setError(null);
    try {
      const res = await window.api.saveManualToken(manualToken);
      if (res.loggedIn) {
        setManualToken('');
      } else {
        setError(res.error || 'Неверный токен.');
      }
    } catch (e) {
      setError('Ошибка при проверке токена.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1>Настройки</h1>

      <div style={{ marginTop: '20px' }}>
        {/* Account settings block */}
        <div className="settings-section">
          <div className="settings-section-title">Аккаунт SoundCloud</div>
          
          {userProfile ? (
            <div>
              <div className="setting-row">
                <div className="setting-meta">
                  <span className="setting-title">Профиль</span>
                  <span className="setting-desc">Вы вошли как <strong>{userProfile.username}</strong>. Доступны ваши плейлисты и личные треки.</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <img
                    src={userProfile.avatar_url || 'https://a-v2.sndcdn.com/assets/images/default/placeholder-artwork-500x500-1c39050.png'}
                    alt="Avatar"
                    style={{ width: '40px', height: '40px', borderRadius: '50%', border: '2px solid var(--accent-color)' }}
                  />
                  <button className="setting-action-btn" onClick={onLogout}>
                    Выйти
                  </button>
                </div>
              </div>
              <div className="setting-row">
                <div className="setting-meta">
                  <span className="setting-title">Безопасность токенов</span>
                  <span className="setting-desc">Ваши учетные данные защищены системным шифрованием ОС (AES-256 DPAPI/Keychain).</span>
                </div>
                <span style={{ fontSize: '12px', color: '#34d399', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                  </svg>
                  safeStorage (Активно)
                </span>
              </div>
            </div>
          ) : (
            <div>
              <div className="setting-row">
                <div className="setting-meta">
                  <span className="setting-title">Авторизоваться</span>
                  <span className="setting-desc">Вход разблокирует личные стримы, плейлисты и лайки.</span>
                </div>
                <button className="setting-action-btn primary" onClick={handleLogin}>
                  Войти через Браузер
                </button>
              </div>

              {/* Advanced mode manually paste cookie */}
              <div style={{ marginTop: '20px', padding: '16px', background: 'rgba(0,0,0,0.15)', borderRadius: '10px', border: '1px solid rgba(255,255,255,0.02)' }}>
                <div style={{ fontSize: '13px', fontWeight: '600', marginBottom: '8px' }}>Ввод куки вручную (Advanced Mode)</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '12px' }}>
                  Если вход через браузер не срабатывает, вы можете скопировать токен авторизации (cookie <code>oauth_token</code>) из DevTools и вставить его ниже.
                </div>
                
                <form onSubmit={handleManualSubmit} style={{ display: 'flex', gap: '10px' }}>
                  <input
                    type="password"
                    className="search-input"
                    placeholder="2-293729-1234567-abcdef..."
                    style={{ flex: 1, padding: '10px 14px', fontSize: '13px' }}
                    value={manualToken}
                    onChange={(e) => setManualToken(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="setting-action-btn"
                    disabled={loading || !manualToken}
                    style={{ minWidth: '100px' }}
                  >
                    {loading ? 'Проверка...' : 'Сохранить'}
                  </button>
                </form>

                {error && (
                  <div style={{ fontSize: '12px', color: '#f87171', marginTop: '8px', fontWeight: '500' }}>
                    {error}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Downloads section */}
        <div className="settings-section">
          <div className="settings-section-title">Загрузки</div>
          
          <div className="setting-row">
            <div className="setting-meta">
              <span className="setting-title">Папка для офлайн-треков</span>
              <span className="setting-desc">Сюда будут скачиваться все MP3 файлы с обложками.</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span className="setting-path-text" title={settings.downloadDirectory}>
                {settings.downloadDirectory}
              </span>
              <button className="setting-action-btn" onClick={handleSelectFolder}>
                Изменить
              </button>
            </div>
          </div>
        </div>

        {/* Clear cache section */}
        <div className="settings-section">
          <div className="settings-section-title">Приложение и Кэш</div>
          
          <div className="setting-row">
            <div className="setting-meta">
              <span className="setting-title">Сброс кэша и настроек</span>
              <span className="setting-desc">Сбрасывает конфигурацию, очищает кэш client_id и выходит из аккаунта. Скачанные файлы останутся на диске.</span>
            </div>
            <button className="setting-action-btn" style={{ color: '#f87171', borderColor: 'rgba(239, 68, 68, 0.2)' }} onClick={handleClearCache}>
              Сбросить настройки
            </button>
          </div>
        </div>
        {/* About section */}
        <div className="settings-section">
          <div className="settings-section-title">О программе</div>

          <div className="setting-row">
            <div className="setting-meta">
              <span className="setting-title">Автор</span>
              <span className="setting-desc">SC4Free — бесплатный клиент SoundCloud с поддержкой офлайн-треков.</span>
            </div>
            <a
              href="https://github.com/qveqa"
              target="_blank"
              rel="noreferrer"
              className="setting-action-btn settings-github-btn"
              onClick={(e) => { e.preventDefault(); window.api.openExternal?.('https://github.com/qveqa'); }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ flexShrink: 0 }}>
                <path d="M12 0C5.37 0 0 5.373 0 12c0 5.303 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.84 1.236 1.84 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.42-1.305.762-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23A11.52 11.52 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.29-1.552 3.295-1.23 3.295-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.605-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.298 24 12c0-6.627-5.373-12-12-12z"/>
              </svg>
              github.com/qveqa
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
