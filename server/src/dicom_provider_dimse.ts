import { DicomProvider, DicomWebResult } from "./dicom_provider.ts";
import { QidoResponse } from "./types.ts";

export class DicomProviderDimse extends DicomProvider {
  async evaluateWado(
    _path: string,
    _reqHeaders: Record<string, string>,
  ): Promise<DicomWebResult> {
    throw await "TODO";
  }

  async evaluateQido(query: Record<string, string>): Promise<QidoResponse> {
    const tempDir = await Deno.makeTempDir();
    // reformat to take advantage of parsing, whicn doesn't understnd "dimse"
    const url = new URL(this.config.endpoint.replace("dimse://", "https://"));
    const findResult = await new Deno.Command("findscu", {
      cwd: tempDir,
      args: [
        ..."-aet NAME -S -k QueryRetrieveLevel=STUDY -k StudyInstanceUID -k PatientName -k PatientID -k StudyDate -k StudyTime -k ModalitiesInStudy -k StudyDescription --extract"
          .split(/\s+/),
        ...Object.entries(query).flatMap(([k, v]) => [`-k`, `${k}=${v}`]),
        url.hostname,
        url.port,
      ],
    }).spawn().status;

    if (!findResult.success) {
      throw "Could not run find"
    }

    const studies = [];
    for await (const studyFile of Deno.readDir(tempDir)) {
      if (studyFile.isFile) {
        const json = await new Deno.Command("dcm2json", {
          cwd: tempDir,
          args: [studyFile.name],
        }).output();
        if (!json.success) {
          continue;
        }
        studies.push(
          JSON.parse(
            new TextDecoder().decode(json.stdout),
          ) as QidoResponse[number],
        );
      }
    }

    // not awaiting; can happen in background
    Deno.remove(tempDir, { recursive: true });
    return studies;
  }
}

DicomProvider.registerType("dicom-dimse", DicomProviderDimse);