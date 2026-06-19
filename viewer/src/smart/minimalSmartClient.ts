import { create } from 'zustand';
import { protocolBodyFromJson, protocolBodyFromText, protocolFormParams, protocolHeaders, protocolUrlParams, recordProtocolEvent, redactUrl, resetProtocolTrace, type ProtocolHttpExchange } from '../protocol/protocolStore';
import type { AssociatedEndpoint, ClientConfig } from '../settings/settingsStore';

type SmartConfiguration = { authorization_endpoint: string; token_endpoint: string; associated_endpoints?: unknown };
type TokenResponse = { access_token?: string; token_type?: string; patient?: string; id_token?: string; scope?: string; expires_in?: number; [key: string]: unknown };
export type StoredSession = { iss: string; patient?: string; tokenResponse: TokenResponse; config: ClientConfig; associatedEndpoints?: AssociatedEndpoint[] };
const PENDING_KEY = 'smart-imaging.viewer.pendingLaunch';
const SESSION_KEY = 'smart-imaging.viewer.session';

function randomUrlSafe(bytes = 32) { const data = new Uint8Array(bytes); crypto.getRandomValues(data); return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256base64url(input: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)); return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function smartDiscoveryUrl(iss: string) { return `${iss.replace(/\/$/, '')}/.well-known/smart-configuration`; }
function cleanUrlAfterCallback() { const url = new URL(window.location.href); ['code','state','session_state'].forEach(k => url.searchParams.delete(k)); window.history.replaceState({}, document.title, url.toString()); }
function appendPatientParam(path: string, patient?: string) { if (!patient) return path; const url = new URL(path, 'http://placeholder.local/'); const resourceType = url.pathname.split('/').filter(Boolean)[0] || ''; if (['Patient','metadata','.well-known'].includes(resourceType)) return path; if (!url.searchParams.has('patient') && !url.searchParams.has('subject')) url.searchParams.set('patient', `Patient/${patient}`); return `${url.pathname.replace(/^\//, '')}${url.search}`; }
type JsonTraceResult<T> = { json: T; exchange: ProtocolHttpExchange };

function bodyTrace(body: BodyInit | null | undefined, contentType?: string) {
  if (body instanceof URLSearchParams) {
    return protocolBodyFromText(body.toString(), contentType, 4000);
  }
  if (typeof body === 'string') return protocolBodyFromText(body, contentType, 4000);
  return undefined;
}

async function fetchJsonWithTrace<T>(title: string, url: string, init: RequestInit = {}, maxResponseChars = 12000): Promise<JsonTraceResult<T>> {
  const headers = new Headers(init.headers);
  const method = init.method || 'GET';
  const exchange: ProtocolHttpExchange = {
    title,
    request: {
      method,
      url: redactUrl(url),
      params: init.body instanceof URLSearchParams ? protocolFormParams(init.body) : protocolUrlParams(url),
      headers: protocolHeaders(headers),
      body: bodyTrace(init.body, headers.get('content-type') || undefined),
    },
  };
  const response = await fetch(url, init);
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = undefined;
  }
  exchange.response = {
    status: response.status,
    statusText: response.statusText,
    headers: protocolHeaders(response.headers),
    body: json === undefined
      ? protocolBodyFromText(text, response.headers.get('content-type') || undefined, maxResponseChars)
      : protocolBodyFromJson(json, maxResponseChars),
  };
  if (!response.ok) {
    const error = new Error(`${title} failed ${response.status}: ${url}`) as Error & { exchange?: ProtocolHttpExchange };
    error.exchange = exchange;
    throw error;
  }
  return { json: json as T, exchange };
}

async function discover(iss: string) {
  const wellKnown = smartDiscoveryUrl(iss);
  return fetchJsonWithTrace<SmartConfiguration>('SMART discovery metadata', wellKnown, { headers: { accept: 'application/json' } }, 12000);
}

async function fhirJsonWithTrace(baseUrl: string, token: string | undefined, path: string, title = 'FHIR request', maxResponseChars = 12000) {
  const url = `${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
  return fetchJsonWithTrace<any>(title, url, { headers: { accept: 'application/fhir+json, application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }, maxResponseChars);
}

async function fhirJson(baseUrl: string, token: string | undefined, path: string) {
  return (await fhirJsonWithTrace(baseUrl, token, path)).json;
}
function normalizeAssociatedEndpoints(value: unknown): AssociatedEndpoint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const endpoints = value.flatMap((endpoint) => {
    if (!endpoint || typeof endpoint !== 'object') return [];
    const record = endpoint as Record<string, unknown>;
    if (typeof record.url !== 'string' || !Array.isArray(record.capabilities)) return [];
    const capabilities = record.capabilities.filter((capability): capability is string => typeof capability === 'string');
    return capabilities.length ? [{ url: record.url, capabilities }] : [];
  });
  return endpoints.length ? endpoints : undefined;
}
export function associatedEndpointForCapability(capability: string, publishedEndpoints?: AssociatedEndpoint[], defaultEndpoints?: AssociatedEndpoint[]) {
  return associatedEndpointSelectionForCapability(capability, publishedEndpoints, defaultEndpoints).endpoint;
}
export function associatedEndpointSelectionForCapability(capability: string, publishedEndpoints?: AssociatedEndpoint[], defaultEndpoints?: AssociatedEndpoint[]) {
  const candidates = publishedEndpoints?.length ? publishedEndpoints : defaultEndpoints;
  const endpoint = candidates?.find((candidate) => candidate.capabilities?.includes(capability));
  return {
    endpoint,
    source: endpoint ? (publishedEndpoints?.length ? 'published' : 'configured-default') : undefined,
    publishedEndpointCount: publishedEndpoints?.length || 0,
    configuredDefaultCount: defaultEndpoints?.length || 0,
  };
}

export class MinimalSmartClient {
  constructor(private session: StoredSession, private baseUrl = session.iss) {}
  get patient() {
    return {
      read: async () => {
        if (!this.session.patient) throw new Error('No patient in SMART token response');
        return fhirJson(this.baseUrl, this.session.tokenResponse.access_token, `Patient/${this.session.patient}`);
      },
      readWithTrace: async (title = 'Patient read') => {
        if (!this.session.patient) throw new Error('No patient in SMART token response');
        return fhirJsonWithTrace(this.baseUrl, this.session.tokenResponse.access_token, `Patient/${this.session.patient}`, title);
      },
      request: async (path: string) => fhirJson(this.baseUrl, this.session.tokenResponse.access_token, appendPatientParam(path, this.session.patient)),
      requestWithTrace: async (path: string, title = 'FHIR request', maxResponseChars = 12000) => fhirJsonWithTrace(this.baseUrl, this.session.tokenResponse.access_token, appendPatientParam(path, this.session.patient), title, maxResponseChars),
    };
  }
  getBaseUrl() { return this.baseUrl; }
  getPatientId() { return this.session.patient; }
  getPatientReference() { return this.session.patient ? `Patient/${this.session.patient}` : 'Patient/{patient}'; }
  async forCapability(capability: string) {
    const selection = associatedEndpointSelectionForCapability(capability, this.session.associatedEndpoints, this.session.config.associatedEndpointDefaults);
    if (!selection.endpoint) {
      recordProtocolEvent({
        stepId: 'endpoint',
        status: 'error',
        title: 'No imaging endpoint found',
        summary: `No endpoint advertised capability ${capability}.`,
        details: {
          capability,
          publishedEndpoints: selection.publishedEndpointCount,
          configuredFallbacks: selection.configuredDefaultCount,
        },
      });
      throw new Error(`No associated endpoint found for ${capability}`);
    }
    recordProtocolEvent({
      stepId: 'endpoint',
      status: 'success',
      title: selection.source === 'published' ? 'Using discovered imaging endpoint' : 'Using configured imaging fallback',
      summary: selection.source === 'published'
        ? 'The EHR launcher published an associated imaging endpoint for this capability.'
        : 'No associated endpoints were published, so the viewer used its configured fallback.',
        details: {
          metadataField: selection.source === 'published' ? 'associated_endpoints' : 'associatedEndpointDefaults',
          capability,
          selectedEndpoint: redactUrl(selection.endpoint.url),
          fallbackCount: selection.configuredDefaultCount,
        },
      });
    return new MinimalSmartClient(this.session, selection.endpoint.url);
  }
  getAuthorizationHeader() { return this.session.tokenResponse.access_token ? `Bearer ${this.session.tokenResponse.access_token}` : ''; }
}

export type SmartState = { client: MinimalSmartClient | null; error?: string; ready: () => Promise<void>; authorize: (config: ClientConfig) => Promise<void>; disconnect: () => void };
export const useSmartStore = create<SmartState>((set) => ({
  client: null,
  ready: async () => { try { set({ client: await ready(), error: undefined }); } catch (e) { console.error(e); set({ client: null, error: String(e) }); } },
  authorize,
  disconnect: () => {
    recordProtocolEvent({
      stepId: 'token',
      status: 'info',
      title: 'Session disconnected',
      summary: 'The viewer removed the stored SMART session from this browser tab.',
    });
    sessionStorage.removeItem(SESSION_KEY);
    set({ client: null });
  },
}));

async function ready(): Promise<MinimalSmartClient | null> {
  const url = new URL(window.location.href); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
  if (!code) { const stored = sessionStorage.getItem(SESSION_KEY); return stored ? new MinimalSmartClient(JSON.parse(stored)) : null; }
  const pendingRaw = sessionStorage.getItem(PENDING_KEY); if (!pendingRaw) throw new Error('No pending SMART launch found');
  const pending = JSON.parse(pendingRaw) as { state: string; verifier: string; redirectUri: string; config: ClientConfig; smartConfig: SmartConfiguration };
  if (!state || state !== pending.state) throw new Error('SMART state mismatch');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, client_id: pending.config.clientId, code_verifier: pending.verifier });
  if (pending.config.clientSecret) body.set('client_secret', pending.config.clientSecret);
  recordProtocolEvent({
    stepId: 'token',
    status: 'pending',
    title: 'Exchanging authorization code',
    summary: 'The viewer is posting the authorization code to the SMART token endpoint.',
    details: {
      tokenEndpoint: redactUrl(pending.smartConfig.token_endpoint),
      grantType: 'authorization_code',
      clientId: pending.config.clientId,
      redirectUri: redactUrl(pending.redirectUri),
      pkce: 'code_verifier',
    },
    detailDocument: {
      title: 'SMART token request',
      narrative: 'The viewer returned from the authorization server with an authorization code, then posted it to the token endpoint with its PKCE verifier.',
      keyDetails: {
        tokenEndpoint: pending.smartConfig.token_endpoint,
        grantType: 'authorization_code',
        clientId: pending.config.clientId,
        redirectUri: pending.redirectUri,
      },
      exchanges: [{
        title: 'Pending token exchange',
        request: {
          method: 'POST',
          url: pending.smartConfig.token_endpoint,
          params: protocolFormParams(body),
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          body: protocolBodyFromText(body.toString(), 'application/x-www-form-urlencoded', 4000),
        },
      }],
    },
  });
  let tokenTrace: JsonTraceResult<TokenResponse>;
  try {
    tokenTrace = await fetchJsonWithTrace<TokenResponse>('SMART token exchange', pending.smartConfig.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body }, 12000);
  } catch (error) {
    const exchange = (error as Error & { exchange?: ProtocolHttpExchange }).exchange;
    recordProtocolEvent({
      stepId: 'token',
      status: 'error',
      title: 'Token exchange failed',
      summary: error instanceof Error ? error.message : String(error),
      details: { tokenEndpoint: pending.smartConfig.token_endpoint, grantType: 'authorization_code', status: exchange?.response?.status || 'error' },
      detailDocument: {
        title: 'SMART token exchange failed',
        narrative: 'The token endpoint did not return a successful token response.',
        keyDetails: {
          tokenEndpoint: pending.smartConfig.token_endpoint,
          grantType: 'authorization_code',
          status: exchange?.response?.status || 'error',
        },
        exchanges: exchange ? [exchange] : undefined,
      },
    });
    throw error;
  }
  const token = tokenTrace.json;
  const session: StoredSession = { iss: pending.config.iss, patient: typeof token.patient === 'string' ? token.patient : undefined, tokenResponse: token, config: pending.config, associatedEndpoints: normalizeAssociatedEndpoints(pending.smartConfig.associated_endpoints) };
  recordProtocolEvent({
    stepId: 'token',
    status: 'success',
    title: 'Access token received',
    summary: 'The SMART token response supplied patient launch context and an access token for FHIR requests.',
    details: {
      tokenEndpoint: redactUrl(pending.smartConfig.token_endpoint),
      grantType: 'authorization_code',
      returnedContext: session.patient ? 'patient' : 'none',
      associatedEndpointSource: 'SMART discovery associated_endpoints',
    },
    detailDocument: {
      title: 'SMART token response',
      narrative: 'The token endpoint returned the access token and launch context that the viewer uses for clinical FHIR, imaging FHIR, and DICOMweb requests.',
      keyDetails: {
        tokenEndpoint: pending.smartConfig.token_endpoint,
        grantType: 'authorization_code',
        tokenType: typeof token.token_type === 'string' ? token.token_type : '',
        patient: session.patient || '',
        scope: typeof token.scope === 'string' ? token.scope : '',
        associatedEndpointSource: 'SMART discovery associated_endpoints',
      },
      exchanges: [tokenTrace.exchange],
    },
  });
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); sessionStorage.removeItem(PENDING_KEY); cleanUrlAfterCallback(); return new MinimalSmartClient(session);
}

export async function authorize(config: ClientConfig) {
  resetProtocolTrace();
  sessionStorage.removeItem(SESSION_KEY);
  recordProtocolEvent({
    stepId: 'config',
    status: 'info',
    title: 'Connection config selected',
    summary: 'The viewer starts from a selected SMART issuer and client configuration.',
    details: {
      label: config.label,
      issuer: redactUrl(config.iss),
      clientId: config.clientId,
      requestedScope: config.scope || 'launch/patient patient/*.rs',
      fallbackEndpoints: config.associatedEndpointDefaults?.length || 0,
    },
  });
  const discoveryUrl = smartDiscoveryUrl(config.iss);
  recordProtocolEvent({
    stepId: 'discovery',
    status: 'pending',
    title: 'Fetching SMART discovery',
    summary: 'The viewer is reading the issuer metadata before starting OAuth.',
    details: { url: redactUrl(discoveryUrl) },
  });
  let smartConfig: SmartConfiguration;
  let discoveryExchange: ProtocolHttpExchange | undefined;
  try {
    const discovery = await discover(config.iss);
    smartConfig = discovery.json;
    discoveryExchange = discovery.exchange;
    const associatedEndpoints = normalizeAssociatedEndpoints(smartConfig.associated_endpoints);
    recordProtocolEvent({
      stepId: 'discovery',
      status: 'success',
      title: 'SMART discovery loaded',
      summary: associatedEndpoints?.length
        ? 'Discovery published associated imaging endpoints.'
        : 'Discovery did not publish associated imaging endpoints.',
      details: {
        request: `GET ${redactUrl(discoveryUrl)}`,
        reads: 'authorization_endpoint, token_endpoint, associated_endpoints',
        associatedEndpointCapability: associatedEndpoints?.map((endpoint) => endpoint.capabilities.join(', ')).join('; ') || 'none',
      },
      detailDocument: {
        title: 'SMART discovery metadata',
        narrative: 'The viewer fetched SMART discovery metadata from the issuer to learn OAuth endpoints and imaging-associated endpoints before starting authorization.',
        keyDetails: {
          request: `GET ${discoveryUrl}`,
          authorizationEndpoint: smartConfig.authorization_endpoint,
          tokenEndpoint: smartConfig.token_endpoint,
          associatedEndpointCapability: associatedEndpoints?.map((endpoint) => endpoint.capabilities.join(', ')).join('; ') || 'none',
        },
        exchanges: discoveryExchange ? [discoveryExchange] : undefined,
      },
    });
  } catch (error) {
    const exchange = (error as Error & { exchange?: ProtocolHttpExchange }).exchange;
    recordProtocolEvent({
      stepId: 'discovery',
      status: 'error',
      title: 'SMART discovery failed',
      summary: String(error),
      details: { url: redactUrl(discoveryUrl) },
      detailDocument: {
        title: 'SMART discovery failed',
        narrative: 'The viewer could not load SMART discovery metadata from the selected issuer.',
        keyDetails: { url: discoveryUrl },
        exchanges: exchange ? [exchange] : undefined,
      },
    });
    throw error;
  }
  const state = randomUrlSafe(24); const verifier = randomUrlSafe(64); const challenge = await sha256base64url(verifier); const redirectUri = new URL(window.location.pathname, window.location.origin).toString();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, redirectUri, config, smartConfig }));
  const authUrl = new URL(smartConfig.authorization_endpoint); authUrl.searchParams.set('response_type', 'code'); authUrl.searchParams.set('client_id', config.clientId); authUrl.searchParams.set('redirect_uri', redirectUri); authUrl.searchParams.set('scope', config.scope || 'launch/patient patient/*.rs'); authUrl.searchParams.set('aud', config.iss); authUrl.searchParams.set('state', state); authUrl.searchParams.set('code_challenge', challenge); authUrl.searchParams.set('code_challenge_method', 'S256');
  const launch = new URLSearchParams(window.location.search).get('launch'); if (launch) authUrl.searchParams.set('launch', launch);
  recordProtocolEvent({
    stepId: 'authorize',
    status: 'pending',
    title: 'Redirecting for authorization',
    summary: 'The viewer is sending the user through SMART authorization with PKCE.',
    details: {
      endpoint: redactUrl(smartConfig.authorization_endpoint),
      responseType: 'code',
      clientId: config.clientId,
      redirectUri: redactUrl(redirectUri),
      aud: redactUrl(config.iss),
      scope: config.scope || 'launch/patient patient/*.rs',
      pkce: 'code_challenge_method=S256',
      launch: launch || 'not present',
    },
    detailDocument: {
      title: 'SMART authorization redirect',
      narrative: 'The viewer sends the browser to the authorization endpoint with SMART App Launch parameters and PKCE. The response is handled by the browser redirect back to the viewer, so there is no XHR response body for this step.',
      keyDetails: {
        endpoint: smartConfig.authorization_endpoint,
        clientId: config.clientId,
        redirectUri,
        aud: config.iss,
        scope: config.scope || 'launch/patient patient/*.rs',
        pkce: 'S256',
      },
      exchanges: [{
        title: 'Browser authorization redirect',
        request: {
          method: 'GET',
          url: authUrl.toString(),
          params: protocolUrlParams(authUrl.toString()),
          headers: { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        },
        notes: ['The browser navigates to this URL; the resulting page is not fetched through fetch/XHR.'],
      }],
    },
  });
  window.location.href = authUrl.toString();
}
