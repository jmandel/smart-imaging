import * as asserts from "https://deno.land/std@0.180.0/testing/asserts.ts";
import * as fhir from "./fhir.ts";

import { Hono } from "./deps.ts";
import { fhirBundle, testPatient } from "./fixtures.ts";
import { HonoEnv } from "./types.ts";
import { DicomProvider } from "./dicomweb.ts";

Deno.test("FHIR", async (_t) => {
  const cases = {
    "/metadata": 200,
    "/metadata/": 404,
    "/metadata/bad": 404,
    "/Resource?patient=BAD": 403,
    [`/Resource?patient=${testPatient.id}`]: 404,
    [`/ImagingStudy?patient=${testPatient.id}`]: 200,
    [`/ImagingStudy?patient=BAD`]: 403,
    [`/ImagingStudy`]: 403,
    [`/ImagingStudy?`]: 403,
    [`/Resource`]: 403,
  };

  const app = new Hono<HonoEnv>();
  app
    .use("*", async (c, next) => {
      c.set("tenantAuthz", {
        patient: testPatient,
        disableAuthzChecks: false,
      });
      c.set("tenantImageProvider", {
        lookupStudies: async () => await fhirBundle,
        delayed: () => ({ delayed: false }),
      } as unknown as DicomProvider);
      await next();
    })
    .route("/fhir", fhir.fhirRouter);

  for (const [path, status] of Object.entries(cases)) {
    const response = await app.request("/fhir" + path);
    asserts.assertEquals(
      status,
      response.status,
      `Path ${path} expected ${status} but saw ${response.status}`,
    );
  }
});
