import * as asserts from "https://deno.land/std@0.180.0/testing/asserts.ts";
import {DicomProviderDimse} from "./dicom_provider_dimse.ts";
import { DicomProviderConfig } from "./dicom_provider.ts";

export const testConfig: DicomProviderConfig = {
  type: "dicom-dimse",
  lookup: "studies-by-mrn",
  endpoint: "dimse://imaging-local.argo.run:30042",
} as DicomProviderConfig;

Deno.test({name: "DICOM DIMSE", ignore: true, async fn(t){
  const d = new DicomProviderDimse(testConfig, "https://us.example.org");
  await t.step("Evaluate dicom dimse query", async () => {
    const r = await d.evaluateQido({"PatientID": "293ee354-f8ad-4345-b10c-759fdfdcc082"});
    asserts.assert(r.length > 0)
  });
}})