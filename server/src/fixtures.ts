import * as dicomweb from "./dicom_provider.ts";
import { Patient } from "./types.ts";

export const testConfig: dicomweb.DicomProviderConfig = {
  type: "dicom-web",
  lookup: "studies-by-mrn",
  endpoint: "https://your.dicom-web.endpoint",
  authentication: {
    type: "http-basic",
    username: "your-username",
    password: "your-password",
  },
};

export const testPatient: Patient = {
  id: "123",
  name: [
    {
      text: "A B",
      given: ["A"],
      family: "B",
    },
  ],
  identifier: [
    {
      type: {
        coding: [
          {
            system: "http://terminology.hl7.org/CodeSystem/v2-0203",
            code: "MR",
          },
        ],
      },
      system: "http://example.org",
      value: "123",
    },
  ],
};
export const qidoMock = [
  {
    "00080005": {
      Value: ["ISO_IR 100"],
      vr: "CS",
    },
    "00080020": {
      vr: "DA",
    },
    "00080030": {
      vr: "TM",
    },
    "00080050": {
      vr: "SH",
    },
    "00080061": {
      Value: ["MR"],
      vr: "CS",
    },
    "00080090": {
      vr: "PN",
    },
    "00081190": {
      Value: [
        "http://imaging-local.argo.run/dicom-web/studies/1.2.276.0.7230010.3.1.2.4094314496.1.1679168756.833040",
      ],
      vr: "UR",
    },
    "00100010": {
      Value: [
        {
          Alphabetic: "Anonymized2",
        },
      ],
      vr: "PN",
    },
    "00100020": {
      Value: ["84f6591c-e2d5-450e-b480-420c9943a6e3"],
      vr: "LO",
    },
    "00100030": {
      vr: "DA",
    },
    "00100040": {
      vr: "CS",
    },
    "0020000D": {
      Value: ["1.2.276.0.7230010.3.1.2.4094314496.1.1679168756.833040"],
      vr: "UI",
    },
    "00200010": {
      vr: "SH",
    },
    "00201206": {
      Value: [14],
      vr: "IS",
    },
    "00201208": {
      Value: [263],
      vr: "IS",
    },
  },
];

export const fhirBundle = {
  resourceType: "Bundle",
  entry: [],
};
