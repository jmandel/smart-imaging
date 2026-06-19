import { create } from 'zustand';
import servers from '../servers.json';
import { appBaseUrl } from '../appBase';

export type AssociatedEndpoint = { url: string; capabilities: string[] };
export type ClientConfig = {
  label: string;
  iss: string;
  clientId: string;
  scope?: string;
  associatedEndpointDefaults?: AssociatedEndpoint[];
  clientSecret?: string;
  pkceMode?: string;
};
export type Settings = {
  clientConfig: ClientConfig[];
  selectedServerIndex?: number;
};

type SettingsState = {
  clientConfig: ClientConfig[];
  selectedServerIndex: number;
  factorySettings: Settings;
  settingsLoaded: boolean;
  settingsError?: string;
  loadSettings: () => Promise<void>;
  setSelectedServerIndex: (i: number) => void;
  getSettingsJson: () => string;
  saveSettingsJson: (json: string) => void;
  resetSettings: () => void;
  settingsResettable: () => boolean;
  factoryUpdatesAvailable: () => boolean;
};

const SETTINGS_KEY = 'smart-imaging.viewer.settings';
const SETTINGS_FACTORY_KEY = 'smart-imaging.viewer.settingsFactory';
const BUNDLED_FACTORY = normalizeSettings(servers);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeAssociatedEndpoints(value: unknown): AssociatedEndpoint[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('associatedEndpointDefaults must be an array');
  return value.map((endpoint) => {
    if (!isRecord(endpoint) || typeof endpoint.url !== 'string' || !Array.isArray(endpoint.capabilities)) {
      throw new Error('associated endpoint entries require url and capabilities');
    }
    const capabilities = endpoint.capabilities.map((capability) => {
      if (typeof capability !== 'string') throw new Error('associated endpoint capabilities must be strings');
      return capability;
    });
    return { url: endpoint.url, capabilities };
  });
}

function normalizeClientConfig(value: unknown): ClientConfig {
  if (!isRecord(value)) throw new Error('clientConfig entries must be objects');
  if (typeof value.label !== 'string') throw new Error('clientConfig entries require label');
  if (typeof value.iss !== 'string') throw new Error('clientConfig entries require iss');
  if (typeof value.clientId !== 'string') throw new Error('clientConfig entries require clientId');

  return {
    label: value.label,
    iss: value.iss,
    clientId: value.clientId,
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    ...(value.associatedEndpointDefaults !== undefined
      ? { associatedEndpointDefaults: normalizeAssociatedEndpoints(value.associatedEndpointDefaults) }
      : {}),
    ...(typeof value.clientSecret === 'string' ? { clientSecret: value.clientSecret } : {}),
    ...(typeof value.pkceMode === 'string' ? { pkceMode: value.pkceMode } : {}),
  };
}

function normalizeSettings(value: unknown): Settings {
  if (!isRecord(value) || !Array.isArray(value.clientConfig)) {
    throw new Error('settings require a clientConfig array');
  }
  const clientConfig = value.clientConfig.map(normalizeClientConfig);
  const selectedServerIndex = typeof value.selectedServerIndex === 'number'
    ? Math.max(0, Math.min(Math.trunc(value.selectedServerIndex), Math.max(clientConfig.length - 1, 0)))
    : undefined;
  return {
    clientConfig,
    ...(selectedServerIndex !== undefined ? { selectedServerIndex } : {}),
  };
}

function stringifySettings(settings: Settings) {
  return JSON.stringify(settings, null, 2);
}

function settingsEqual(a: Settings, b: Settings) {
  return stringifySettings(a) === stringifySettings(b);
}

function settingsFromState(state: SettingsState): Settings {
  return {
    clientConfig: state.clientConfig,
    selectedServerIndex: state.selectedServerIndex,
  };
}

async function fetchRuntimeSettings(url: URL): Promise<Settings | null> {
  try {
    const response = await fetch(url, { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const settings = normalizeSettings(await response.json());
    return settings.clientConfig.length ? settings : null;
  } catch (error) {
    console.warn(`Could not load viewer settings from ${url}`, error);
    return null;
  }
}

async function loadFactorySettings() {
  const base = appBaseUrl();
  return (
    await fetchRuntimeSettings(new URL('config/config.json', base)) ||
    await fetchRuntimeSettings(new URL('config.json', base)) ||
    BUNDLED_FACTORY
  );
}

function loadStoredSettings(factorySettings: Settings) {
  const stored = window.localStorage.getItem(SETTINGS_KEY);
  if (!stored) return factorySettings;

  try {
    return normalizeSettings(JSON.parse(stored));
  } catch (error) {
    console.warn('Discarding invalid saved viewer settings', error);
    window.localStorage.removeItem(SETTINGS_KEY);
    window.localStorage.removeItem(SETTINGS_FACTORY_KEY);
    return factorySettings;
  }
}

function persistSettings(settings: Settings, factorySettings: Settings) {
  if (settingsEqual(settings, factorySettings)) {
    window.localStorage.removeItem(SETTINGS_KEY);
    window.localStorage.removeItem(SETTINGS_FACTORY_KEY);
    return;
  }
  window.localStorage.setItem(SETTINGS_KEY, stringifySettings(settings));
  window.localStorage.setItem(SETTINGS_FACTORY_KEY, stringifySettings(factorySettings));
}

function applySettings(set: (partial: Partial<SettingsState>) => void, settings: Settings, factorySettings: Settings) {
  const selectedServerIndex = settings.selectedServerIndex ?? factorySettings.selectedServerIndex ?? 0;
  set({
    clientConfig: settings.clientConfig,
    selectedServerIndex: Math.max(0, Math.min(selectedServerIndex, Math.max(settings.clientConfig.length - 1, 0))),
    factorySettings,
  });
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  clientConfig: BUNDLED_FACTORY.clientConfig,
  selectedServerIndex: 0,
  factorySettings: BUNDLED_FACTORY,
  settingsLoaded: false,
  loadSettings: async () => {
    try {
      const factorySettings = await loadFactorySettings();
      const settings = loadStoredSettings(factorySettings);
      applySettings(set, settings, factorySettings);
      set({ settingsLoaded: true, settingsError: undefined });
    } catch (error) {
      set({ settingsLoaded: true, settingsError: String(error) });
    }
  },
  setSelectedServerIndex: (selectedServerIndex) => set({ selectedServerIndex }),
  getSettingsJson: () => stringifySettings(settingsFromState(get())),
  saveSettingsJson: (json) => {
    const settings = normalizeSettings(JSON.parse(json));
    const factorySettings = get().factorySettings;
    persistSettings(settings, factorySettings);
    applySettings(set, settings, factorySettings);
  },
  resetSettings: () => {
    const factorySettings = get().factorySettings;
    window.localStorage.removeItem(SETTINGS_KEY);
    window.localStorage.removeItem(SETTINGS_FACTORY_KEY);
    applySettings(set, factorySettings, factorySettings);
  },
  settingsResettable: () => !settingsEqual(settingsFromState(get()), get().factorySettings),
  factoryUpdatesAvailable: () => {
    const lastFactory = window.localStorage.getItem(SETTINGS_FACTORY_KEY);
    return Boolean(lastFactory && lastFactory !== stringifySettings(get().factorySettings));
  },
}));
