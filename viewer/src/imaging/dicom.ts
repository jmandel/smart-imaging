import * as dicomParser from 'dicom-parser';
import * as cornerstone from 'cornerstone-core';
import * as cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import { parseMultipart } from '../multipart';
import { appAssetUrl } from '../appBase';

cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
let initialized = false;
export function initCornerstone() {
  if (initialized) return;
  initialized = true;
  cornerstoneWADOImageLoader.webWorkerManager.initialize({
    maxWebWorkers: navigator.hardwareConcurrency || 1,
    startWebWorkersOnDemand: true,
    webWorkerTaskPaths: [
      appAssetUrl('610.bundle.min.worker.js'),
      appAssetUrl('888.bundle.min.worker.js'),
    ],
    taskConfiguration: { decodeTask: { initializeCodecsOnStartup: false } },
  });
}

export type InstanceDetails = { imageId: string; patientName?: string; patientId?: string; instanceDate?: string; studyDescription?: string; seriesNumber: number; seriesDescription?: string; instanceNumber: number };
export type LoadedStudy = { date?: string; description?: string; patient: { name?: string; id?: string }; series: { number: number; name?: string; instances: string[] }[] };

function parseStudyMetadata(study: Uint8Array[]): InstanceDetails[] {
  cornerstoneWADOImageLoader.wadouri.fileManager.purge();
  cornerstoneWADOImageLoader.wadouri.dataSetCacheManager.purge();
  return study.map((dicomData) => {
    const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(new Blob([dicomData.buffer.slice(dicomData.byteOffset, dicomData.byteOffset + dicomData.byteLength) as ArrayBuffer]));
    const dataSet = dicomParser.parseDicom(dicomData);
    return {
      imageId,
      patientName: dataSet.string('x00100010'),
      patientId: dataSet.string('x00100020'),
      instanceDate: dataSet.string('x00080012'),
      studyDescription: dataSet.string('x00081030'),
      seriesNumber: dataSet.intString('x00200011') || 0,
      seriesDescription: dataSet.string('x0008103e'),
      instanceNumber: dataSet.intString('x00200013') || 0,
    };
  });
}

export function toLoadedStudy(instances: InstanceDetails[]): LoadedStudy | null {
  if (!instances.length) return null;
  const groups = new Map<number, InstanceDetails[]>();
  [...instances].sort((a,b) => a.seriesNumber - b.seriesNumber).forEach(i => groups.set(i.seriesNumber, [...(groups.get(i.seriesNumber)||[]), i]));
  return {
    date: instances[0].instanceDate,
    description: instances[0].studyDescription,
    patient: { name: instances[0].patientName, id: instances[0].patientId },
    series: [...groups.entries()].map(([number, arr]) => ({ number, name: arr[0].seriesDescription, instances: arr.sort((a,b) => a.instanceNumber - b.instanceNumber).map(i => i.imageId) })),
  };
}

export async function fetchDicomStudy(address: string, uid: string, authorization: string) {
  const studyMultipart = await fetch(`${address}/studies/${uid}`, { headers: { accept: 'multipart/related; type=application/dicom; transfer-syntax=*', authorization } });
  if (!studyMultipart.ok) throw new Error(`WADO failed ${studyMultipart.status}`);
  const parsed = await parseMultipart(studyMultipart);
  return parseStudyMetadata(parsed.parts.map((p) => p.body));
}
