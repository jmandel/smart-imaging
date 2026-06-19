import { create } from 'zustand';
import { recordProtocolEvent, redactUrl } from '../protocol/protocolStore';
import type { MinimalSmartClient } from '../smart/minimalSmartClient';
import { fetchDicomStudyWithTrace, toLoadedStudy, type LoadedStudy } from './dicom';

type StudyToFetch = { address: string; uid: string; modality?: string; description?: string };
export type { StudyToFetch };
type ImagingState = { studies: StudyToFetch[] | null; loadedStudy: LoadedStudy | null; selectedSeries: number | null; selectedInstance: string | null; loading: boolean; error?: string; loadStudies: (client: MinimalSmartClient) => Promise<void>; fetchStudy: (client: MinimalSmartClient, s: StudyToFetch) => Promise<void>; selectSeries: (i: number) => void; selectInstanceIndex: (i: number) => void; nextInstance: (delta: number) => void; clearStudy: () => void };

export const useImagingStore = create<ImagingState>((set, get) => ({
  studies: null, loadedStudy: null, selectedSeries: null, selectedInstance: null, loading: false,
  loadStudies: async (client) => {
    set({loading:true, error: undefined});
    try {
      const imageClient = await client.forCapability('smart-imaging-access');
      const imagingPath = 'ImagingStudy?_include=ImagingStudy:endpoint';
      const imagingQuery = `${imagingPath}&patient=Patient/{patient}`;
      recordProtocolEvent({
        stepId: 'imaging',
        status: 'pending',
        title: 'Searching imaging studies',
        summary: 'The viewer is querying the imaging FHIR endpoint for studies and included Endpoint resources.',
        details: {
          endpoint: redactUrl(imageClient.getBaseUrl()),
          query: imagingQuery,
          keyParams: '_include=ImagingStudy:endpoint, patient=Patient/{patient}',
        },
      });
      const imageTrace = await imageClient.patient.requestWithTrace('ImagingStudy?_include=ImagingStudy:endpoint', 'ImagingStudy search with Endpoint include', 24000);
      const images = imageTrace.json;
      const endpoints = images?.entry?.filter((r:any) => r.resource.resourceType === 'Endpoint') || [];
      const resolveReference = (ref:string, resource:any) => ref.startsWith('#') ? resource.contained?.find((r:any) => r.id === ref.slice(1)) : endpoints.find((e:any) => e?.fullUrl === ref)?.resource ?? endpoints.find((e:any) => e?.resource?.id === ref.split('/')[1])?.resource;
      const studies = (images.entry || []).map((e:any) => e.resource).filter((r:any) => r.resourceType === 'ImagingStudy').map((r:any) => ({ uid: r.identifier[0].value.slice(8), address: resolveReference(r.endpoint[0].reference, r).address, modality: r.modality?.[0]?.code, description: r.description || r.modality?.[0]?.code }));
      recordProtocolEvent({
        stepId: 'imaging',
        status: 'success',
        title: 'Imaging studies loaded',
        summary: 'The viewer queried ImagingStudy and asked FHIR to include retrieval Endpoint resources.',
        details: {
          endpoint: redactUrl(imageClient.getBaseUrl()),
          query: imagingQuery,
          keyParams: '_include=ImagingStudy:endpoint, patient=Patient/{patient}',
        },
        detailDocument: {
          title: 'ImagingStudy search',
          narrative: 'The viewer queried the imaging FHIR endpoint for ImagingStudy resources and asked FHIR to include Endpoint resources that describe DICOM retrieval services.',
          keyDetails: {
            endpoint: imageClient.getBaseUrl(),
            query: imagingQuery,
            keyParams: '_include=ImagingStudy:endpoint, patient=Patient/{patient}',
            returnedStudies: studies.length,
          },
          exchanges: [imageTrace.exchange],
          notes: ['The FHIR response body is captured with a size cap because ImagingStudy bundles can get large.'],
        },
      });
      set({studies, loading:false});
    } catch (e) {
      recordProtocolEvent({
        stepId: 'imaging',
        status: 'error',
        title: 'ImagingStudy query failed',
        summary: String(e),
      });
      set({error:String(e), loading:false});
    }
  },
  fetchStudy: async (client, study) => {
    set({loading:true, error: undefined});
    recordProtocolEvent({
      stepId: 'dicom',
      status: 'pending',
      title: 'Fetching DICOM instances',
      summary: 'The viewer is following the ImagingStudy Endpoint address to retrieve DICOM pixels.',
      details: {
        endpoint: redactUrl(study.address),
        query: 'GET /studies/{studyUid}',
        studyUid: study.uid,
        accept: 'multipart/related; type=application/dicom; transfer-syntax=*',
        auth: 'Bearer access token',
      },
    });
    try {
      const dicomTrace = await fetchDicomStudyWithTrace(study.address, study.uid, client.getAuthorizationHeader());
      const loadedStudy = toLoadedStudy(dicomTrace.instances);
      recordProtocolEvent({
        stepId: 'dicom',
        status: 'success',
        title: 'DICOM study loaded',
        summary: 'The DICOMweb endpoint returned the selected study as multipart DICOM.',
        details: {
          endpoint: redactUrl(study.address),
          query: 'GET /studies/{studyUid}',
          studyUid: study.uid,
          accept: 'multipart/related; type=application/dicom; transfer-syntax=*',
        },
        detailDocument: {
          title: 'DICOMweb WADO-RS retrieval',
          narrative: 'The viewer followed the Endpoint address from the ImagingStudy result and fetched DICOM instances for display in the image viewport.',
          keyDetails: {
            endpoint: study.address,
            studyUid: study.uid,
            accept: 'multipart/related; type=application/dicom; transfer-syntax=*',
            instanceCount: dicomTrace.instances.length,
          },
          exchanges: [dicomTrace.exchange],
          notes: ['DICOM instance binaries are summarized rather than expanded in the detail page.'],
        },
      });
      set({loadedStudy, selectedSeries: 0, selectedInstance: loadedStudy?.series[0]?.instances[0] || null, loading:false});
    }
    catch (e) {
      const exchange = (e as Error & { exchange?: import('../protocol/protocolStore').ProtocolHttpExchange }).exchange;
      recordProtocolEvent({
        stepId: 'dicom',
        status: 'error',
        title: 'DICOMweb retrieval failed',
        summary: String(e),
        details: { endpoint: redactUrl(study.address) },
        detailDocument: {
          title: 'DICOMweb retrieval failed',
          narrative: 'The viewer could not retrieve DICOM instances from the Endpoint address selected from ImagingStudy.',
          keyDetails: {
            endpoint: study.address,
            studyUid: study.uid,
          },
          exchanges: exchange ? [exchange] : undefined,
        },
      });
      set({error:String(e), loading:false});
    }
  },
  selectSeries: (i) => { const s = get().loadedStudy?.series[i]; if (!s) return; set({selectedSeries:i, selectedInstance:s.instances[0] || null}); },
  selectInstanceIndex: (i) => { const {loadedStudy, selectedSeries} = get(); if (!loadedStudy || selectedSeries === null) return; const arr = loadedStudy.series[selectedSeries].instances; if (i >= 0 && i < arr.length) set({selectedInstance: arr[i]}); },
  nextInstance: (delta) => { const {loadedStudy, selectedSeries, selectedInstance} = get(); if (!loadedStudy || selectedSeries === null) return; const arr = loadedStudy.series[selectedSeries].instances; const idx = arr.indexOf(selectedInstance || ''); const next = idx + delta; if (next >= 0 && next < arr.length) set({selectedInstance: arr[next]}); },
  clearStudy: () => set({loadedStudy:null, selectedSeries:null, selectedInstance:null}),
}));
