import { create } from 'zustand';
import { recordProtocolEvent, redactUrl } from '../protocol/protocolStore';
import type { MinimalSmartClient } from '../smart/minimalSmartClient';

type ClinicalState = { details: any | null; error?: string; load: (client: MinimalSmartClient) => Promise<void> };
function clinicalQueries() {
  const patient = 'Patient/{patient}';
  return [
    'Patient/{patient}',
    `AllergyIntolerance?clinical-status=active&patient=${patient}`,
    `Condition?clinical-status=active&patient=${patient}`,
    `MedicationRequest?status=active&patient=${patient}`,
  ].join('\n');
}

export const useClinicalStore = create<ClinicalState>((set) => ({
  details: null,
  load: async (client) => {
    const clinicalPaths = [
      'Patient/{patient}',
      'AllergyIntolerance?clinical-status=active&patient=Patient/{patient}',
      'Condition?clinical-status=active&patient=Patient/{patient}',
      'MedicationRequest?status=active&patient=Patient/{patient}',
    ];
    recordProtocolEvent({
      stepId: 'clinical',
      status: 'pending',
      title: 'Reading clinical FHIR data',
      summary: 'The viewer is using the SMART access token against the clinical FHIR endpoint.',
      details: {
        endpoint: redactUrl(client.getBaseUrl()),
        queries: clinicalQueries(),
        auth: 'Bearer access token',
      },
    });
    try {
      const patientTrace = await client.patient.readWithTrace('Patient context read');
      const patient = patientTrace.json;
      const statuses = ['AllergyIntolerance?clinical-status=active','Condition?clinical-status=active','MedicationRequest?status=active'];
      const bundles = await Promise.all(statuses.map((status) => client.patient.requestWithTrace(status, `${status.split('?')[0]} active search`, 12000)));
      const activeCounts = Object.fromEntries(bundles.map((result:any, i) => [statuses[i].split('?')[0], result.json?.entry?.length || 0]));
      recordProtocolEvent({
        stepId: 'clinical',
        status: 'success',
        title: 'Clinical context loaded',
        summary: 'The viewer queried patient demographics and active clinical resource searches from the EHR FHIR endpoint.',
        details: {
          endpoint: redactUrl(client.getBaseUrl()),
          queries: clinicalQueries(),
          keyParams: 'clinical-status=active, status=active, patient=Patient/{patient}',
        },
        detailDocument: {
          title: 'Clinical FHIR reads',
          narrative: 'The viewer used the SMART access token against the clinical FHIR endpoint to read patient context and active clinical resource counts.',
          keyDetails: {
            endpoint: client.getBaseUrl(),
            patient: client.getPatientReference(),
            queries: clinicalPaths.join('\n'),
          },
          exchanges: [patientTrace.exchange, ...bundles.map((bundle:any) => bundle.exchange)],
          notes: ['FHIR Bundle response bodies are captured with a size cap so the trace stays usable.'],
        },
      });
      set({details: { name: patient.name?.[0]?.text || `${patient.name?.[0]?.given?.join(' ') || ''} ${patient.name?.[0]?.family || ''}`, birthDate: patient.birthDate, activeCounts }, error: undefined});
    } catch (e) {
      recordProtocolEvent({
        stepId: 'clinical',
        status: 'error',
        title: 'Clinical FHIR read failed',
        summary: String(e),
        details: { endpoint: redactUrl(client.getBaseUrl()) },
      });
      set({error:String(e)});
    }
  }
}));
