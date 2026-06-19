import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../settings/settingsStore';
import { useSmartStore } from '../smart/minimalSmartClient';
import { useClinicalStore } from '../clinical/clinicalStore';
import { useImagingStore } from '../imaging/imagingStore';
import { initCornerstone } from '../imaging/dicom';
import { DicomViewport } from './DicomViewport';
import { SettingsModal } from './SettingsModal';

const clinicalResourceLabels: Record<string, string> = {
  AllergyIntolerance: 'Allergy Intolerances',
  Condition: 'Conditions',
  MedicationRequest: 'Medication Requests',
};

export function App() {
  const { clientConfig, selectedServerIndex, setSelectedServerIndex, settingsLoaded, settingsError } = useSettingsStore();
  const { client, authorize, error: smartError, disconnect } = useSmartStore();
  const clinical = useClinicalStore();
  const imaging = useImagingStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selected = clientConfig[selectedServerIndex];
  const selectedSeries = imaging.selectedSeries !== null && imaging.loadedStudy ? imaging.loadedStudy.series[imaging.selectedSeries] : null;
  const selectedInstanceIndex = selectedSeries ? selectedSeries.instances.indexOf(imaging.selectedInstance || '') : -1;
  const statusText = imaging.error || (imaging.loading ? (imaging.loadedStudy ? 'Loading study...' : 'Loading imaging studies...') : 'Ready');

  useEffect(() => { initCornerstone(); }, []);
  useEffect(() => { if (client && !clinical.details && !clinical.error) clinical.load(client); }, [client]);
  useEffect(() => { if (client && imaging.studies === null && !imaging.loading) imaging.loadStudies(client); }, [client]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
      if (settingsOpen) {
        if (e.key === 'Escape') {
          e.preventDefault();
          setSettingsOpen(false);
        }
        return;
      }
      if (e.key === 'Escape' && imaging.loadedStudy) {
        e.preventDefault();
        imaging.clearStudy();
      }
      if (e.key === 'ArrowRight' || e.key === '>' || e.key === '.') { e.preventDefault(); imaging.nextInstance(1); }
      if (e.key === 'ArrowLeft' || e.key === '<' || e.key === ',') { e.preventDefault(); imaging.nextInstance(-1); }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= 9) {
        if (!imaging.loadedStudy && client && imaging.studies?.[n - 1]) imaging.fetchStudy(client, imaging.studies[n - 1]);
        else if (imaging.loadedStudy && imaging.loadedStudy.series[n - 1]) imaging.selectSeries(n - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [client, imaging, settingsOpen]);

  return <div className="app-page">
    <div className="menu-bar container">
      <h1 className="logo">SMART<span className="logo-image-mark" aria-hidden="true" />Demo</h1>
      <nav className="nav-links">
        <button className="settings-trigger" onClick={() => setSettingsOpen((open) => !open)}>
          <span>Settings</span><span className="settings-icon" aria-hidden="true" />
        </button>
      </nav>
    </div>
    <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    <main className="container app-container">
      <div className="app-grid">
        <aside className="side-rail">
          <section className="content-box panel-fixed launcher-panel">
            <h2>Connection</h2>
            {!client ? <>
              <select className="server-select" disabled={!settingsLoaded} value={selectedServerIndex} onChange={e => setSelectedServerIndex(parseInt(e.target.value))}>
                {clientConfig.map((server, i) => <option key={server.label} value={i}>{server.label}</option>)}
              </select>
              <button className="primary-action" disabled={!settingsLoaded || !selected} onClick={() => selected && authorize(selected)}>Connect</button>
              <div className="status-line error">{settingsError || smartError || (!settingsLoaded ? 'Loading settings...' : '\u00a0')}</div>
            </> : <>
              <p className="connected-state">Connected</p>
              <button className="primary-action" onClick={disconnect}>Disconnect</button>
            </>}
          </section>

          <section className="content-box panel-fixed clinical-panel">
            <h2>Clinical Data</h2>
            {!client ? <div className="empty-panel">Connect to load patient context.</div> : clinical.details ? <>
              <dl className="data-list">
                <div><dt>Patient</dt><dd>{clinical.details.name || '\u00a0'}</dd></div>
                <div><dt>Birth Date</dt><dd>{clinical.details.birthDate || '\u00a0'}</dd></div>
                {Object.entries(clinical.details.activeCounts || {}).map(([resource, count]) => (
                  <div key={resource}>
                    <dt>{clinicalResourceLabels[resource] || resource}</dt>
                    <dd>{String(count)} active</dd>
                  </div>
                ))}
              </dl>
            </> : <div className="empty-panel">Loading clinical data...</div>}
            <div className="status-line error">{client ? (clinical.error || '\u00a0') : '\u00a0'}</div>
          </section>

          <section className="content-box study-sidebar panel-fixed">
            <div className="panel-heading">
              <h2>Imaging Studies</h2>
              {imaging.loadedStudy && <button className="text-action" onClick={imaging.clearStudy}><span>Back</span><span className="inline-key">Esc</span></button>}
            </div>
            {!client ? <div className="empty-panel">Connect to load imaging studies.</div> : !imaging.loadedStudy ? <>
              <div className={`status-line ${imaging.error ? 'error' : ''}`}>{statusText}</div>
              <div className="button-list">
                {(imaging.studies || []).map((study, i) => <button className="hotkey-button stable-button" disabled={imaging.loading} key={study.uid} onClick={() => client && imaging.fetchStudy(client, study)}><span className="button-label">{study.description || study.uid}</span>{i < 9 && <span className="hotkey">{i+1}</span>}</button>)}
              </div>
              {imaging.studies?.length === 0 && <em>No studies available</em>}
            </> : <>
              <dl className="data-list compact">
                <div><dt>Patient</dt><dd>{imaging.loadedStudy.patient.name || '\u00a0'}</dd></div>
                <div><dt>Study Date</dt><dd>{imaging.loadedStudy.date || '\u00a0'}</dd></div>
                <div><dt>Description</dt><dd>{imaging.loadedStudy.description || '\u00a0'}</dd></div>
              </dl>
              <div className="series-buttons button-list">
                {imaging.loadedStudy.series.map((series, i) => <button key={series.number} className={`hotkey-button stable-button ${imaging.selectedSeries === i ? 'active' : ''}`} onClick={() => imaging.selectSeries(i)}><span className="button-label">{series.name || `Series ${series.number}`}</span><span className="hotkey">{i+1}</span></button>)}
              </div>
            </>}
          </section>
        </aside>

        <section className="content-box viewer-panel">
          {imaging.selectedInstance && selectedSeries ? <>
            <div className="slice-controls">
              <button className="slice-button" onClick={() => imaging.nextInstance(-1)} disabled={selectedInstanceIndex <= 0}><span>Prev</span><span className="inline-key">&larr;</span></button>
              <input className="instance-slider" type="range" min={0} max={Math.max(selectedSeries.instances.length - 1, 0)} value={Math.max(selectedInstanceIndex, 0)} onChange={e => imaging.selectInstanceIndex(parseInt(e.target.value, 10))} onInput={e => imaging.selectInstanceIndex(parseInt((e.target as HTMLInputElement).value, 10))} />
              <button className="slice-button" onClick={() => imaging.nextInstance(1)} disabled={selectedInstanceIndex >= selectedSeries.instances.length - 1}><span>Next</span><span className="inline-key">&rarr;</span></button>
              <span className="slice-count">{selectedInstanceIndex + 1} / {selectedSeries.instances.length}</span>
            </div>
            <DicomViewport imageId={imaging.selectedInstance} />
          </> : <div className="empty-viewer">Connect and choose an imaging study.</div>}
        </section>
      </div>
      <footer className="content-box app-footer">SMART Imaging Access.</footer>
    </main>
  </div>;
}
