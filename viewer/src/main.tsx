import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './app.css';
import { App } from './components/App';
import { useSmartStore } from './smart/minimalSmartClient';
import { useSettingsStore } from './settings/settingsStore';

function Root() {
  const ready = useSmartStore(s => s.ready);
  const loadSettings = useSettingsStore(s => s.loadSettings);
  useEffect(() => { loadSettings(); ready(); }, [loadSettings, ready]);
  return <App />;
}

createRoot(document.getElementById('root')!).render(<Root />);
