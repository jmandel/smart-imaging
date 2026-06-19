import { create } from 'zustand';
import type { MinimalSmartClient } from '../smart/minimalSmartClient';
import { fetchDicomStudy, toLoadedStudy, type LoadedStudy } from './dicom';

type StudyToFetch = { address: string; uid: string; modality?: string; description?: string };
export type { StudyToFetch };
type ImagingState = { studies: StudyToFetch[] | null; loadedStudy: LoadedStudy | null; selectedSeries: number | null; selectedInstance: string | null; loading: boolean; error?: string; loadStudies: (client: MinimalSmartClient) => Promise<void>; fetchStudy: (client: MinimalSmartClient, s: StudyToFetch) => Promise<void>; selectSeries: (i: number) => void; selectInstanceIndex: (i: number) => void; nextInstance: (delta: number) => void; clearStudy: () => void };

export const useImagingStore = create<ImagingState>((set, get) => ({
  studies: null, loadedStudy: null, selectedSeries: null, selectedInstance: null, loading: false,
  loadStudies: async (client) => {
    set({loading:true, error: undefined});
    try {
      const imageClient = await client.forCapability('smart-imaging-access');
      const images = await imageClient.patient.request('ImagingStudy?_include=ImagingStudy:endpoint');
      const endpoints = images?.entry?.filter((r:any) => r.resource.resourceType === 'Endpoint') || [];
      const resolveReference = (ref:string, resource:any) => ref.startsWith('#') ? resource.contained?.find((r:any) => r.id === ref.slice(1)) : endpoints.find((e:any) => e?.fullUrl === ref)?.resource ?? endpoints.find((e:any) => e?.resource?.id === ref.split('/')[1])?.resource;
      const studies = (images.entry || []).map((e:any) => e.resource).filter((r:any) => r.resourceType === 'ImagingStudy').map((r:any) => ({ uid: r.identifier[0].value.slice(8), address: resolveReference(r.endpoint[0].reference, r).address, modality: r.modality?.[0]?.code, description: r.description || r.modality?.[0]?.code }));
      set({studies, loading:false});
    } catch (e) { set({error:String(e), loading:false}); }
  },
  fetchStudy: async (client, study) => {
    set({loading:true, error: undefined});
    try { const instances = await fetchDicomStudy(study.address, study.uid, client.getAuthorizationHeader()); const loadedStudy = toLoadedStudy(instances); set({loadedStudy, selectedSeries: 0, selectedInstance: loadedStudy?.series[0]?.instances[0] || null, loading:false}); }
    catch (e) { set({error:String(e), loading:false}); }
  },
  selectSeries: (i) => { const s = get().loadedStudy?.series[i]; if (!s) return; set({selectedSeries:i, selectedInstance:s.instances[0] || null}); },
  selectInstanceIndex: (i) => { const {loadedStudy, selectedSeries} = get(); if (!loadedStudy || selectedSeries === null) return; const arr = loadedStudy.series[selectedSeries].instances; if (i >= 0 && i < arr.length) set({selectedInstance: arr[i]}); },
  nextInstance: (delta) => { const {loadedStudy, selectedSeries, selectedInstance} = get(); if (!loadedStudy || selectedSeries === null) return; const arr = loadedStudy.series[selectedSeries].instances; const idx = arr.indexOf(selectedInstance || ''); const next = idx + delta; if (next >= 0 && next < arr.length) set({selectedInstance: arr[next]}); },
  clearStudy: () => set({loadedStudy:null, selectedSeries:null, selectedInstance:null}),
}));
