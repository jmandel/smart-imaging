import { create } from 'zustand';

export type ProtocolStepId = 'config' | 'discovery' | 'authorize' | 'token' | 'clinical' | 'endpoint' | 'imaging' | 'dicom';
export type ProtocolStatus = 'info' | 'pending' | 'success' | 'error';
type ProtocolDetailValue = string | number | boolean | undefined | null;

export type ProtocolBody = {
  contentType?: string;
  text: string;
  truncated?: boolean;
  originalBytes?: number;
  note?: string;
};

export type ProtocolHttpExchange = {
  title: string;
  request: {
    method: string;
    url: string;
    params?: Record<string, string>;
    headers?: Record<string, string>;
    body?: ProtocolBody;
  };
  response?: {
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body?: ProtocolBody;
  };
  notes?: string[];
};

export type ProtocolDetailDocument = {
  title?: string;
  narrative?: string;
  keyDetails?: Record<string, ProtocolDetailValue>;
  exchanges?: ProtocolHttpExchange[];
  notes?: string[];
};

export type ProtocolEvent = {
  id: string;
  stepId: ProtocolStepId;
  status: ProtocolStatus;
  title: string;
  summary: string;
  at: string;
  details?: Record<string, ProtocolDetailValue>;
  detailDocument?: ProtocolDetailDocument;
};

type ProtocolState = {
  events: ProtocolEvent[];
  open: boolean;
  selectedStepId?: ProtocolStepId;
  setOpen: (open: boolean) => void;
  showStep: (stepId?: ProtocolStepId) => void;
  record: (event: Omit<ProtocolEvent, 'id' | 'at'>) => void;
  reset: () => void;
};

const STORAGE_KEY = 'smart-imaging.viewer.protocolTrace';
const UI_STORAGE_KEY = 'smart-imaging.viewer.protocolTraceUi';
const MAX_EVENTS = 80;

function storageAvailable() {
  return typeof window !== 'undefined' && Boolean(window.sessionStorage);
}

function readEvents(): ProtocolEvent[] {
  if (!storageAvailable()) return [];
  try {
    const stored = window.sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeEvents(events: ProtocolEvent[]) {
  if (!storageAvailable()) return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events));
}

function readUiState(): { open: boolean; selectedStepId?: ProtocolStepId } {
  if (!storageAvailable()) return { open: false };
  try {
    const stored = window.sessionStorage.getItem(UI_STORAGE_KEY);
    if (!stored) return { open: false };
    const parsed = JSON.parse(stored);
    return {
      open: parsed?.open === true,
      selectedStepId: parsed?.selectedStepId,
    };
  } catch {
    return { open: false };
  }
}

function writeUiState(open: boolean, selectedStepId?: ProtocolStepId) {
  if (!storageAvailable()) return;
  window.sessionStorage.setItem(UI_STORAGE_KEY, JSON.stringify({ open, selectedStepId }));
}

export function redactUrl(value: string) {
  return value;
}

function truncateText(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n\n... truncated ${text.length - maxChars} characters ...`, truncated: true };
}

export function protocolHeaders(headers: Headers | Record<string, string | undefined>) {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), value || '']));
}

export function protocolUrlParams(url: string) {
  const parsed = new URL(url, typeof window === 'undefined' ? 'http://placeholder.local' : window.location.origin);
  return Object.fromEntries([...parsed.searchParams.entries()]);
}

export function protocolFormParams(params: URLSearchParams) {
  return Object.fromEntries([...params.entries()]);
}

export function protocolBodyFromJson(value: unknown, maxChars = 12000): ProtocolBody {
  const rendered = JSON.stringify(value, null, 2);
  const truncated = truncateText(rendered, maxChars);
  return {
    contentType: 'application/json',
    text: truncated.text,
    truncated: truncated.truncated,
    originalBytes: new TextEncoder().encode(rendered).byteLength,
  };
}

export function protocolBodyFromText(text: string, contentType?: string, maxChars = 12000): ProtocolBody {
  const truncated = truncateText(text, maxChars);
  return {
    contentType,
    text: truncated.text,
    truncated: truncated.truncated,
    originalBytes: new TextEncoder().encode(text).byteLength,
  };
}

const initialUiState = readUiState();

export const useProtocolStore = create<ProtocolState>((set, get) => ({
  events: readEvents(),
  open: initialUiState.open,
  selectedStepId: initialUiState.selectedStepId,
  setOpen: (open) => {
    const selectedStepId = get().selectedStepId;
    writeUiState(open, selectedStepId);
    set({ open });
  },
  showStep: (selectedStepId) => {
    writeUiState(true, selectedStepId);
    set({ open: true, selectedStepId });
  },
  record: (event) => {
    const next = [
      ...get().events,
      {
        ...event,
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        at: new Date().toISOString(),
      },
    ].slice(-MAX_EVENTS);
    writeEvents(next);
    set({ events: next });
  },
  reset: () => {
    writeEvents([]);
    writeUiState(get().open, undefined);
    set({ events: [], selectedStepId: undefined });
  },
}));

export function recordProtocolEvent(event: Omit<ProtocolEvent, 'id' | 'at'>) {
  useProtocolStore.getState().record(event);
}

export function resetProtocolTrace() {
  useProtocolStore.getState().reset();
}

export function latestProtocolEvent(events: ProtocolEvent[], stepId: ProtocolStepId) {
  return [...events].reverse().find((event) => event.stepId === stepId);
}
