import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../settings/settingsStore';

type SettingsModalProps = {
  open: boolean;
  onClose: () => void;
};

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const getSettingsJson = useSettingsStore((state) => state.getSettingsJson);
  const saveSettingsJson = useSettingsStore((state) => state.saveSettingsJson);
  const resetSettings = useSettingsStore((state) => state.resetSettings);
  const settingsResettable = useSettingsStore((state) => state.settingsResettable);
  const factoryUpdatesAvailable = useSettingsStore((state) => state.factoryUpdatesAvailable);
  const clientConfig = useSettingsStore((state) => state.clientConfig);
  const selectedServerIndex = useSettingsStore((state) => state.selectedServerIndex);
  const factorySettings = useSettingsStore((state) => state.factorySettings);
  const [editableSettings, setEditableSettings] = useState('');
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open) return;
    setEditableSettings(getSettingsJson());
    setError(undefined);
  }, [open, getSettingsJson, clientConfig, selectedServerIndex, factorySettings]);

  if (!open) return null;

  function save() {
    try {
      saveSettingsJson(editableSettings);
      setError(undefined);
      onClose();
    } catch (error) {
      setError(String(error));
    }
  }

  function reset() {
    resetSettings();
    setEditableSettings(getSettingsJson());
    setError(undefined);
  }

  return (
    <div className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="container fullheight">
        <div className="row fullheight">
          <div className="col col-4 content-box fullheight settings-panel">
            <textarea
              className="settings-editor"
              spellCheck={false}
              value={editableSettings}
              onChange={(event) => setEditableSettings(event.target.value)}
            />
            <div className="settings-actions">
              <button disabled={editableSettings === getSettingsJson()} onClick={save}>Save Settings</button>
              <button onClick={onClose}>Close</button>
              <button onClick={reset} disabled={!settingsResettable()}>
                {factoryUpdatesAvailable() ? '! ' : ''}Reset all to defaults
              </button>
            </div>
            <div className="status-line error">{error || '\u00a0'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
