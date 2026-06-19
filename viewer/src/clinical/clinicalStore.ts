import { create } from 'zustand';
import type { MinimalSmartClient } from '../smart/minimalSmartClient';

type ClinicalState = { details: any | null; error?: string; load: (client: MinimalSmartClient) => Promise<void> };
export const useClinicalStore = create<ClinicalState>((set) => ({
  details: null,
  load: async (client) => {
    try {
      const patient = await client.patient.read();
      const statuses = ['AllergyIntolerance?clinical-status=active','Condition?clinical-status=active','MedicationRequest?status=active'];
      const activeCounts = Object.fromEntries((await Promise.all(statuses.map(s => s.split('?')[0]).map(r => client.patient.request(r)))).map((rb:any, i) => [statuses[i].split('?')[0], rb?.entry?.length || 0]));
      set({details: { name: patient.name?.[0]?.text || `${patient.name?.[0]?.given?.join(' ') || ''} ${patient.name?.[0]?.family || ''}`, birthDate: patient.birthDate, activeCounts }, error: undefined});
    } catch (e) { set({error:String(e)}); }
  }
}));
