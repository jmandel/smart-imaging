import type {DicomProvider} from "./dicomweb.ts"

export interface AppState {
  authorizedForPatient: Patient;
  introspected: IntrospectionResponse;
  imagesProvider: DicomProvider
}

export interface IntrospectionResponse {
  active: boolean;
  scope: string;
  patient: string;
}

export interface Patient {
  id: string;
  identifier: Identifier[];
  name: { given: string[]; family: string; text: string }[];
}

export enum TAGS {
  MODALITY = "00080061",
  STUDY_UID = "0020000D",
}

export type QidoResponse = {
  [TAGS.MODALITY]: {
    Value: [string];
  };
  [TAGS.STUDY_UID]: {
    Value: [string];
  };
}[];

export interface Identifier {
  system?: string;
  value: string;
  display?: string;
  type: CodeableConcept;
}

export interface CodeableConcept {
  coding: Coding[];
  text?: string;
}

export interface Coding {
  system?: string;
  code: string;
  display?: string;
}

export interface FhirResponse {
  resourceType: "Bundle";
  entry: {
    resource: {
      resourceType: "ImagingStudy";
      identifier: {
        system: "urn:dicom:uid";
        value: string;
      }[];
      contained: ({
        resourceType: "Endpoint";
        id: string;
        address: string;
      } & Record<string, unknown>)[];
      id: string;
      modality: Coding[];
      status: "available";
      endpoint: { reference: string };
    };
  }[];
}
