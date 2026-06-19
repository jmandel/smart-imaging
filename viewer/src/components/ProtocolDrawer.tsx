import { useEffect, useRef } from 'react';
import { latestProtocolEvent, type ProtocolBody, type ProtocolDetailDocument, type ProtocolEvent, type ProtocolHttpExchange, type ProtocolStatus, type ProtocolStepId, useProtocolStore } from '../protocol/protocolStore';

type StepMeta = {
  number: number;
  label: string;
  explainer: string;
  href: string;
  hrefLabel: string;
};

const stepMeta: Record<ProtocolStepId, StepMeta> = {
  config: {
    number: 1,
    label: 'Connection config',
    explainer: 'The viewer starts with an issuer, client ID, requested scopes, and optional fallback imaging endpoints.',
    href: 'https://build.fhir.org/ig/HL7/smart-app-launch/conformance.html',
    hrefLabel: 'SMART discovery',
  },
  discovery: {
    number: 2,
    label: 'SMART discovery',
    explainer: 'The viewer reads .well-known/smart-configuration to learn OAuth endpoints and any associated imaging endpoints.',
    href: 'https://github.com/sync-for-science/imaging#discovery-of-imaging-fhir-endpoints',
    hrefLabel: 'Imaging endpoint discovery',
  },
  authorize: {
    number: 3,
    label: 'Authorization',
    explainer: 'The viewer redirects through SMART App Launch with PKCE and requests patient launch context.',
    href: 'https://build.fhir.org/ig/HL7/smart-app-launch/app-launch.html',
    hrefLabel: 'SMART launch flow',
  },
  token: {
    number: 4,
    label: 'Token response',
    explainer: 'The authorization code is exchanged for an access token and patient context used by later API calls.',
    href: 'https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html',
    hrefLabel: 'Scopes and context',
  },
  clinical: {
    number: 5,
    label: 'Clinical FHIR',
    explainer: 'The same SMART session is used to read patient context and clinical resources from the EHR endpoint.',
    href: 'https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html',
    hrefLabel: 'FHIR scopes',
  },
  endpoint: {
    number: 6,
    label: 'Imaging endpoint',
    explainer: 'The viewer selects an imaging FHIR endpoint by capability, preferring published associated endpoints over configured fallbacks.',
    href: 'https://github.com/sync-for-science/imaging#discovery-of-imaging-fhir-endpoints',
    hrefLabel: 'Associated endpoints',
  },
  imaging: {
    number: 7,
    label: 'ImagingStudy query',
    explainer: 'The imaging FHIR endpoint returns ImagingStudy resources and Endpoint references that point to DICOM retrieval services.',
    href: 'https://build.fhir.org/imagingstudy.html',
    hrefLabel: 'FHIR ImagingStudy',
  },
  dicom: {
    number: 8,
    label: 'DICOMweb retrieval',
    explainer: 'The viewer follows the Endpoint address and retrieves DICOM instances for display.',
    href: 'https://build.fhir.org/endpoint.html',
    hrefLabel: 'FHIR Endpoint',
  },
};

const orderedStepIds = Object.keys(stepMeta) as ProtocolStepId[];

function statusLabel(status?: ProtocolStatus) {
  if (!status) return 'Not run';
  return status === 'pending' ? 'Running' : status[0].toUpperCase() + status.slice(1);
}

function eventTime(event?: ProtocolEvent) {
  return event ? new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
}

function eventDateTime(event: ProtocolEvent) {
  return new Date(event.at).toLocaleString();
}

function rangeStatus(events: ProtocolEvent[], stepIds: ProtocolStepId[]) {
  const finalEvent = latestProtocolEvent(events, stepIds[stepIds.length - 1]);
  const rangeEvents = stepIds.map((id) => latestProtocolEvent(events, id)).filter(Boolean) as ProtocolEvent[];
  if (rangeEvents.some((event) => event.status === 'error')) return 'error';
  if (finalEvent?.status === 'success') return 'success';
  if (rangeEvents.some((event) => event.status === 'pending')) return 'pending';
  return finalEvent?.status || rangeEvents[rangeEvents.length - 1]?.status;
}

function compactDetailValue(value: string) {
  const lines = value.split('\n');
  const compacted = lines.length > 3 ? `${lines.slice(0, 3).join('\n')}\n...` : value;
  return compacted.length > 140 ? `${compacted.slice(0, 137)}...` : compacted;
}

function detailsList(event?: ProtocolEvent) {
  if (!event?.details) return null;
  const details = Object.entries(event.details).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!details.length) return null;
  return <dl className="protocol-details">
    {details.map(([key, value]) => {
      const full = String(value);
      const rendered = compactDetailValue(full);
      const wide = rendered.includes('\n') || rendered.length > 72;
      return <div key={key} className={wide ? 'protocol-detail-wide' : undefined}>
        <dt>{key.replace(/([A-Z])/g, ' $1')}</dt>
        <dd title={full}>{rendered}</dd>
      </div>;
    })}
  </dl>;
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function tableHtml(values?: Record<string, unknown>) {
  const entries = Object.entries(values || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (!entries.length) return '';
  return `<table>${entries.map(([key, value]) => `<tr><th>${escapeHtml(key.replace(/([A-Z])/g, ' $1'))}</th><td>${escapeHtml(value)}</td></tr>`).join('')}</table>`;
}

function bodyHtml(body?: ProtocolBody) {
  if (!body) return '';
  return `<div class="body-block">
    <div class="body-meta">${escapeHtml(body.contentType || 'body')}${body.truncated ? ' · truncated' : ''}${body.originalBytes ? ` · ${body.originalBytes.toLocaleString()} bytes` : ''}</div>
    ${body.note ? `<p>${escapeHtml(body.note)}</p>` : ''}
    <pre>${escapeHtml(body.text)}</pre>
  </div>`;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function curlCommand(exchange: ProtocolHttpExchange) {
  const parts = ['curl'];
  if (exchange.request.method !== 'GET') parts.push('-X', exchange.request.method);
  parts.push(shellQuote(exchange.request.url));
  Object.entries(exchange.request.headers || {}).forEach(([name, value]) => {
    if (value) parts.push('-H', shellQuote(`${name}: ${value}`));
  });
  if (exchange.request.body?.text) {
    parts.push('--data-raw', shellQuote(exchange.request.body.text));
  }
  return parts.join(' \\\n  ');
}

function exchangeHtml(exchange: ProtocolHttpExchange, index: number) {
  const curlId = `curl-${index}`;
  return `<section class="exchange">
    <h2>${escapeHtml(exchange.title)}</h2>
    <div class="copy-row">
      <button type="button" data-copy="${escapeHtml(curlId)}">Copy as curl</button>
    </div>
    <pre id="${escapeHtml(curlId)}" class="curl-block">${escapeHtml(curlCommand(exchange))}</pre>
    <h3>Request</h3>
    <table>
      <tr><th>Method</th><td>${escapeHtml(exchange.request.method)}</td></tr>
      <tr><th>URL</th><td>${escapeHtml(exchange.request.url)}</td></tr>
    </table>
    ${tableHtml(exchange.request.params) ? `<h4>Request Params</h4>${tableHtml(exchange.request.params)}` : ''}
    ${tableHtml(exchange.request.headers) ? `<h4>Request Headers</h4>${tableHtml(exchange.request.headers)}` : ''}
    ${bodyHtml(exchange.request.body)}
    ${exchange.response ? `<h3>Response</h3>
      <table><tr><th>Status</th><td>${escapeHtml(`${exchange.response.status}${exchange.response.statusText ? ` ${exchange.response.statusText}` : ''}`)}</td></tr></table>
      ${tableHtml(exchange.response.headers) ? `<h4>Response Headers</h4>${tableHtml(exchange.response.headers)}` : ''}
      ${bodyHtml(exchange.response.body)}` : '<p class="muted">No HTTP response was available for this step. The browser navigated away for this part of the flow.</p>'}
    ${exchange.notes?.length ? `<h4>Notes</h4><ul>${exchange.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>` : ''}
  </section>`;
}

function detailDocument(event: ProtocolEvent, meta: StepMeta): ProtocolDetailDocument {
  return event.detailDocument || {
    title: event.title,
    narrative: event.summary || meta.explainer,
    keyDetails: event.details,
  };
}

function detailHtml(event: ProtocolEvent, meta: StepMeta) {
  const document = detailDocument(event, meta);
  const keyDetails = { status: statusLabel(event.status), capturedAt: eventDateTime(event), ...(document.keyDetails || event.details || {}) };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(document.title || event.title)}</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 2rem; background: #171717; color: #f5f5f5; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { max-width: 980px; margin: 0 auto; }
    h1 { margin: 0 0 .35rem; font-size: 2rem; }
    h2 { margin: 1.5rem 0 .5rem; font-size: 1.25rem; }
    h3 { margin: 1rem 0 .35rem; font-size: 1rem; color: #f0fff4; }
    h4 { margin: .9rem 0 .35rem; color: #bdbdbd; text-transform: uppercase; font-size: .8rem; letter-spacing: 0; }
    .muted, .meta { color: #bdbdbd; }
    .status { display: inline-flex; align-items: center; gap: .35rem; margin: .7rem 0 1.25rem; color: #bdbdbd; }
    .dot { width: .65rem; height: .65rem; border-radius: 50%; background: #8f8f8f; display: inline-block; }
    .success .dot { background: #56d364; } .pending .dot { background: #f0bf56; } .error .dot { background: #ff8182; }
    section { border: 1px solid rgba(255,255,255,.16); border-radius: 6px; background: #262626; padding: 1rem; margin: 1rem 0; }
    table { width: 100%; border-collapse: collapse; margin: .5rem 0; table-layout: fixed; }
    th, td { border-top: 1px solid rgba(255,255,255,.12); padding: .45rem .5rem; vertical-align: top; overflow-wrap: anywhere; }
    th { width: 13rem; color: #bdbdbd; text-align: left; font-weight: 500; text-transform: uppercase; font-size: .78rem; }
    pre { margin: .5rem 0 0; padding: .8rem; overflow: auto; background: #111; border: 1px solid rgba(255,255,255,.12); border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
    button { background: #3a3a3a; color: #f5f5f5; border: 1px solid rgba(255,255,255,.22); border-radius: 4px; padding: .45rem .7rem; cursor: pointer; }
    button:hover { background: #454545; }
    .copy-row { display: flex; justify-content: flex-end; margin: -.25rem 0 .5rem; }
    .curl-block { white-space: pre-wrap; }
    .body-meta { color: #bdbdbd; font-size: .85rem; margin-top: .5rem; }
    a { color: #7ee787; }
  </style>
</head>
<body>
  <main class="${escapeHtml(event.status)}">
    <h1>${escapeHtml(document.title || event.title)}</h1>
    <div class="status"><span class="dot"></span>${escapeHtml(statusLabel(event.status))} · ${escapeHtml(eventDateTime(event))}</div>
    <p>${escapeHtml(document.narrative || event.summary || meta.explainer)}</p>
    ${tableHtml(keyDetails) ? `<section><h2>Key Details</h2>${tableHtml(keyDetails)}</section>` : ''}
    ${document.exchanges?.map(exchangeHtml).join('') || ''}
    ${document.notes?.length ? `<section><h2>Notes</h2><ul>${document.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>` : ''}
    <section><h2>Reference</h2><a href="${escapeHtml(meta.href)}">${escapeHtml(meta.hrefLabel)}</a></section>
  </main>
  <script>
    document.addEventListener('click', async (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest('button[data-copy]');
      if (!button) return;
      const block = document.getElementById(button.dataset.copy || '');
      if (!block) return;
      await navigator.clipboard.writeText(block.textContent || '');
      const original = button.textContent;
      button.textContent = 'Copied';
      window.setTimeout(() => { button.textContent = original; }, 1200);
    });
  </script>
</body>
</html>`;
}

function openProtocolDetails(event: ProtocolEvent, meta: StepMeta) {
  const blob = new Blob([detailHtml(event, meta)], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function ProtocolButton() {
  const open = useProtocolStore((s) => s.open);
  const events = useProtocolStore((s) => s.events);
  const setOpen = useProtocolStore((s) => s.setOpen);
  const latest = events[events.length - 1];

  return <button className={`protocol-trigger ${open ? 'active' : ''}`} onClick={() => setOpen(!open)}>
    <span>Protocol</span>
    <span className={`protocol-status ${latest?.status || 'info'}`} aria-hidden="true" />
  </button>;
}

export function ProtocolBadge({ stepId }: { stepId: ProtocolStepId }) {
  const events = useProtocolStore((s) => s.events);
  const showStep = useProtocolStore((s) => s.showStep);
  const event = latestProtocolEvent(events, stepId);
  const meta = stepMeta[stepId];

  return <button
    className={`protocol-badge ${event?.status || 'info'}`}
    title={`${meta.label}: ${statusLabel(event?.status)}`}
    onClick={() => showStep(stepId)}
    aria-label={`Open protocol details for ${meta.label}`}
  >
    {meta.number}
  </button>;
}

export function ProtocolPill({ stepId, label, statusStepIds = [stepId] }: { stepId: ProtocolStepId; label: string; statusStepIds?: ProtocolStepId[] }) {
  const events = useProtocolStore((s) => s.events);
  const showStep = useProtocolStore((s) => s.showStep);
  const status = rangeStatus(events, statusStepIds);
  const meta = stepMeta[stepId];
  const finalMeta = stepMeta[statusStepIds[statusStepIds.length - 1]];
  const title = statusStepIds.length > 1 ? `${meta.label} through ${finalMeta.label}` : meta.label;

  return <button
    className={`protocol-pill ${status || 'info'}`}
    title={`${title}: ${statusLabel(status)}`}
    onClick={() => showStep(stepId)}
    aria-label={`Open protocol details for ${title}`}
  >
    <span className="protocol-pill-icon" aria-hidden="true">i</span>
    <span>{label}</span>
  </button>;
}

export function ProtocolDrawer() {
  const open = useProtocolStore((s) => s.open);
  const selectedStepId = useProtocolStore((s) => s.selectedStepId);
  const events = useProtocolStore((s) => s.events);
  const setOpen = useProtocolStore((s) => s.setOpen);
  const stepRefs = useRef<Partial<Record<ProtocolStepId, HTMLElement | null>>>({});

  useEffect(() => {
    if (!open || !selectedStepId) return;
    stepRefs.current[selectedStepId]?.scrollIntoView({ block: 'start' });
  }, [open, selectedStepId]);

  if (!open) return null;

  return <aside className="protocol-drawer" aria-label="Protocol trace">
    <div className="protocol-drawer-header">
      <div>
        <h2>Protocol Trace</h2>
        <p>{events.length ? `${events.length} events captured in this browser session.` : 'Connect to capture the SMART Imaging flow.'}</p>
      </div>
      <button className="protocol-close" onClick={() => setOpen(false)} aria-label="Close protocol trace">x</button>
    </div>
    <div className="protocol-step-list">
      {orderedStepIds.map((stepId) => {
        const meta = stepMeta[stepId];
        const event = latestProtocolEvent(events, stepId);
        return <section key={stepId} ref={(element) => { stepRefs.current[stepId] = element; }} className={`protocol-step ${selectedStepId === stepId ? 'selected' : ''}`}>
          <div className="protocol-step-heading">
            <span className={`protocol-step-number ${event?.status || 'info'}`}>{meta.number}</span>
            <div>
              <h3>{meta.label}</h3>
              <span>{statusLabel(event?.status)} {event ? `at ${eventTime(event)}` : ''}</span>
            </div>
          </div>
          <p>{event?.summary || meta.explainer}</p>
          {detailsList(event)}
          <div className="protocol-card-footer">
            {event && <button className="protocol-detail-button" onClick={() => openProtocolDetails(event, meta)}>Open request/response</button>}
            <div className="protocol-reference">
              <span>Docs</span>
              <a className="protocol-link" href={meta.href} target="_blank" rel="noreferrer">{meta.hrefLabel}</a>
            </div>
          </div>
        </section>;
      })}
    </div>
  </aside>;
}
