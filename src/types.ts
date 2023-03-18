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
  SPECIFIC_CHARACTER_SET = '00080005',
  STUDY_DATE = '00080020',
  STUDY_TIME = '00080030',
  ACCESSION_NUMBER = '00080050',
  INSTANCE_AVAILABILITY = '00080056',
  MODALITIES_IN_STUDY = '00080061',
  REFERRING_PHYSICIAN_NAME = '00080090',
  TIMEZONE_OFFSET_FROM_UTC = '00080201',
  RETRIEVE_URL = '00081190',
  PATIENT_NAME = '00100010',
  PATIENT_ID = '00100020',
  PATIENT_BIRTH_DATE = '00100030',
  PATIENT_SEX = '00100040',
  STUDY_UID = '0020000D',
  STUDY_ID = '00200010',
  NUMBER_OF_SERIES = '00201206',
  NUMBER_OF_INSTANCES = '00201208',
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
