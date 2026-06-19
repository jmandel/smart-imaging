import { create } from 'zustand';
import type { AssociatedEndpoint, ClientConfig } from '../settings/settingsStore';

type SmartConfiguration = { authorization_endpoint: string; token_endpoint: string };
type TokenResponse = { access_token?: string; token_type?: string; patient?: string; id_token?: string; scope?: string; expires_in?: number; [key: string]: unknown };
type StoredSession = { iss: string; patient?: string; tokenResponse: TokenResponse; config: ClientConfig };
const PENDING_KEY = 'smart-imaging.viewer.pendingLaunch';
const SESSION_KEY = 'smart-imaging.viewer.session';

function randomUrlSafe(bytes = 32) { const data = new Uint8Array(bytes); crypto.getRandomValues(data); return btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function sha256base64url(input: string) { const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)); return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function discover(iss: string): Promise<SmartConfiguration> { const wellKnown = `${iss.replace(/\/$/, '')}/.well-known/smart-configuration`; const response = await fetch(wellKnown, { headers: { accept: 'application/json' } }); if (!response.ok) throw new Error(`SMART discovery failed ${response.status} for ${wellKnown}`); return response.json(); }
function cleanUrlAfterCallback() { const url = new URL(window.location.href); ['code','state','session_state'].forEach(k => url.searchParams.delete(k)); window.history.replaceState({}, document.title, url.toString()); }
function appendPatientParam(path: string, patient?: string) { if (!patient) return path; const url = new URL(path, 'http://placeholder.local/'); const resourceType = url.pathname.split('/').filter(Boolean)[0] || ''; if (['Patient','metadata','.well-known'].includes(resourceType)) return path; if (!url.searchParams.has('patient') && !url.searchParams.has('subject')) url.searchParams.set('patient', `Patient/${patient}`); return `${url.pathname.replace(/^\//, '')}${url.search}`; }
async function fhirJson(baseUrl: string, token: string | undefined, path: string) { const response = await fetch(`${baseUrl.replace(/\/$/, '')}/${path.replace(/^\//, '')}`, { headers: { accept: 'application/fhir+json, application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) } }); if (!response.ok) throw new Error(`FHIR request failed ${response.status}: ${baseUrl}/${path}`); return response.json(); }

export class MinimalSmartClient {
  constructor(private session: StoredSession, private baseUrl = session.iss) {}
  get patient() { return { read: async () => { if (!this.session.patient) throw new Error('No patient in SMART token response'); return fhirJson(this.baseUrl, this.session.tokenResponse.access_token, `Patient/${this.session.patient}`); }, request: async (path: string) => fhirJson(this.baseUrl, this.session.tokenResponse.access_token, appendPatientParam(path, this.session.patient)) }; }
  async forCapability(capability: string) { const endpoint = this.session.config.associatedEndpointDefaults?.find((e: AssociatedEndpoint) => e.capabilities?.includes(capability)); if (!endpoint) throw new Error(`No associated endpoint found for ${capability}`); return new MinimalSmartClient(this.session, endpoint.url); }
  getAuthorizationHeader() { return this.session.tokenResponse.access_token ? `Bearer ${this.session.tokenResponse.access_token}` : ''; }
}

export type SmartState = { client: MinimalSmartClient | null; error?: string; ready: () => Promise<void>; authorize: (config: ClientConfig) => Promise<void>; disconnect: () => void };
export const useSmartStore = create<SmartState>((set) => ({
  client: null,
  ready: async () => { try { set({ client: await ready(), error: undefined }); } catch (e) { console.error(e); set({ client: null, error: String(e) }); } },
  authorize,
  disconnect: () => { sessionStorage.removeItem(SESSION_KEY); set({ client: null }); },
}));

async function ready(): Promise<MinimalSmartClient | null> {
  const url = new URL(window.location.href); const code = url.searchParams.get('code'); const state = url.searchParams.get('state');
  if (!code) { const stored = sessionStorage.getItem(SESSION_KEY); return stored ? new MinimalSmartClient(JSON.parse(stored)) : null; }
  const pendingRaw = sessionStorage.getItem(PENDING_KEY); if (!pendingRaw) throw new Error('No pending SMART launch found');
  const pending = JSON.parse(pendingRaw) as { state: string; verifier: string; redirectUri: string; config: ClientConfig; smartConfig: SmartConfiguration };
  if (!state || state !== pending.state) throw new Error('SMART state mismatch');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: pending.redirectUri, client_id: pending.config.clientId, code_verifier: pending.verifier });
  if (pending.config.clientSecret) body.set('client_secret', pending.config.clientSecret);
  const tokenResponse = await fetch(pending.smartConfig.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
  if (!tokenResponse.ok) throw new Error(`SMART token exchange failed ${tokenResponse.status}: ${await tokenResponse.text()}`);
  const token = await tokenResponse.json() as TokenResponse;
  const session: StoredSession = { iss: pending.config.iss, patient: typeof token.patient === 'string' ? token.patient : undefined, tokenResponse: token, config: pending.config };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); sessionStorage.removeItem(PENDING_KEY); cleanUrlAfterCallback(); return new MinimalSmartClient(session);
}

export async function authorize(config: ClientConfig) {
  sessionStorage.removeItem(SESSION_KEY); const smartConfig = await discover(config.iss); const state = randomUrlSafe(24); const verifier = randomUrlSafe(64); const challenge = await sha256base64url(verifier); const redirectUri = new URL(window.location.pathname, window.location.origin).toString();
  sessionStorage.setItem(PENDING_KEY, JSON.stringify({ state, verifier, redirectUri, config, smartConfig }));
  const authUrl = new URL(smartConfig.authorization_endpoint); authUrl.searchParams.set('response_type', 'code'); authUrl.searchParams.set('client_id', config.clientId); authUrl.searchParams.set('redirect_uri', redirectUri); authUrl.searchParams.set('scope', config.scope || 'launch/patient patient/*.rs'); authUrl.searchParams.set('aud', config.iss); authUrl.searchParams.set('state', state); authUrl.searchParams.set('code_challenge', challenge); authUrl.searchParams.set('code_challenge_method', 'S256');
  const launch = new URLSearchParams(window.location.search).get('launch'); if (launch) authUrl.searchParams.set('launch', launch);
  window.location.href = authUrl.toString();
}
