import { afterEach, describe, expect, it, vi } from 'vitest';
import { MinimalSmartClient, associatedEndpointForCapability, associatedEndpointSelectionForCapability } from './minimalSmartClient';
import type { StoredSession } from './minimalSmartClient';

const defaults = [
  { url: 'https://configured.example/fhir', capabilities: ['smart-imaging-access'] },
];

describe('associatedEndpointForCapability', () => {
  it('uses a published endpoint before the configured default', () => {
    const selection = associatedEndpointSelectionForCapability(
      'smart-imaging-access',
      [{ url: 'https://published.example/fhir', capabilities: ['smart-imaging-access'] }],
      defaults,
    );

    expect(selection.endpoint?.url).toBe('https://published.example/fhir');
    expect(selection.source).toBe('published');
  });

  it('falls back to the configured default when no endpoints are published', () => {
    const selection = associatedEndpointSelectionForCapability('smart-imaging-access', undefined, defaults);

    expect(selection.endpoint?.url).toBe('https://configured.example/fhir');
    expect(selection.source).toBe('configured-default');
  });

  it('falls back to the configured default when discovery publishes an empty endpoint list', () => {
    const endpoint = associatedEndpointForCapability('smart-imaging-access', [], defaults);

    expect(endpoint?.url).toBe('https://configured.example/fhir');
  });

  it('does not fall back when published endpoints omit the requested capability', () => {
    const endpoint = associatedEndpointForCapability(
      'smart-imaging-access',
      [{ url: 'https://published.example/fhir', capabilities: ['other-capability'] }],
      defaults,
    );

    expect(endpoint).toBeUndefined();
  });
});

describe('MinimalSmartClient.forCapability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('routes capability FHIR requests through the published endpoint', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-type': 'application/fhir+json' }),
      text: async () => JSON.stringify({ resourceType: 'Bundle' }),
    } as Response);
    const session: StoredSession = {
      iss: 'https://ehr.example/fhir',
      patient: 'patient-1',
      tokenResponse: { access_token: 'token-1' },
      config: {
        label: 'test',
        iss: 'https://ehr.example/fhir',
        clientId: 'client-1',
        associatedEndpointDefaults: defaults,
      },
      associatedEndpoints: [
        { url: 'https://published.example/fhir', capabilities: ['smart-imaging-access'] },
      ],
    };
    const client = new MinimalSmartClient(session);

    const imagingClient = await client.forCapability('smart-imaging-access');
    await imagingClient.patient.request('ImagingStudy');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://published.example/fhir/ImagingStudy?patient=Patient%2Fpatient-1',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer token-1' }),
      }),
    );
  });
});
