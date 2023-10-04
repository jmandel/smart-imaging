import type { DicomProvider } from "./dicomweb.ts";
import { Context } from "https://deno.land/x/hono@v3.7.3/mod.ts";

// deno-lint-ignore no-explicit-any
export type AppState = {
  tenantConfig: any;
  tenantAuthz: AuthorizationAssignment;
  tenantImageProvider: DicomProvider;
};
export type HonoEnv = { Variables: AppState };
export type AppContext = Context<HonoEnv>;

export interface AuthorizationAssignment {
  patient?: Patient;
  introspected?: IntrospectionResponse;
  disableAuthzChecks?: boolean;
  ehrBaseUrl?: string;
}

export interface IntrospectionResponse {
  sub?: string;
  active: boolean;
  scope: string;
  patient?: string;
}

export interface Patient {
  id: string;
  identifier: Identifier[];
  name: { given: string[]; family: string; text: string }[];
}

export enum TAGS {
  SPECIFIC_CHARACTER_SET = "00080005",
  STUDY_DATE = "00080020",
  STUDY_TIME = "00080030",
  ACCESSION_NUMBER = "00080050",
  INSTANCE_AVAILABILITY = "00080056",
  MODALITIES_IN_STUDY = "00080061",
  MODALITY = "00080060",
  REFERRING_PHYSICIAN_NAME = "00080090",
  TIMEZONE_OFFSET_FROM_UTC = "00080201",
  RETRIEVE_URL = "00081190",
  PATIENT_NAME = "00100010",
  PATIENT_ID = "00100020",
  PATIENT_BIRTH_DATE = "00100030",
  PATIENT_SEX = "00100040",
  STUDY_UID = "0020000D",
  SERIES_UID = "0020000E",
  STUDY_ID = "00200010",
  NUMBER_OF_SERIES = "00201206",
  NUMBER_OF_INSTANCES_IN_STUDY = "00201208",
  NUMBER_OF_INSTANCES_IN_SERIES = "00201209",
  STUDY_DESCRIPTION = "00081030",
  SOP_INSTANCE_UID = "00080018",
  INSTANCE_NUMBER = "00200013",
  SERIES_NUMBER = "00200011",
  SERIES_DESCRIPTION = "0008103E",
  SOP_CLASS_UID = "00080016",
}

export type QidoResponse = {
  // deno-lint-ignore no-explicit-any
  [k in TAGS]: { Value: any[] };
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

export interface Reference {
  display?: string;
  reference?: string;
  identifer?: Identifier;
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
      referrer?: Reference;
      subject?: Reference;
      numberOfSeries?: number;
      numberOfInstances?: number;
      started?: string;
      description?: string;
      contained: ({
        resourceType: "Endpoint";
        id: string;
        address: string;
      } & Record<string, unknown>)[];
      id: string;
      modality: Coding[];
      status: "available";
      endpoint: { reference: string };
      series?: {
        uid: string;
        number?: number;
        modality?: Coding;
        numberOfInstances?: number;
        instance?: {
          uid: string;
          number?: number;
          sopClass: Coding;
        }[];
      }[];
    };
  }[];
}
