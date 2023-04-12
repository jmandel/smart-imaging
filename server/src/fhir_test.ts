import * as asserts from "https://deno.land/std@0.180.0/testing/asserts.ts";
import { oak } from "./deps.ts";
import * as fhir from "./fhir.ts";

import { fhirBundle, testPatient } from "./fixtures.ts";
import { AppState } from "./types.ts";

Deno.test("FHIR", async (t) => {
  const fhirRoutes = fhir.fhirRouter.routes();

  const next = oak.testing.createMockNext();
  const makeContext = (path: string) =>
    oak.testing.createMockContext<string, { [k: string]: string }, AppState>({
      path,
      state: {
        authorizedForPatient: testPatient,
        imagesProvider: {
          lookupStudies: async (p: any) => fhirBundle,
          delayed: () => ({ delayed: false }),
        },
      },
    });

  const cases = {
    "/metadata": true,
    "/metadata/": true,
    "/Resource?patient=BAD": false,
    [`/Resource?patient=${testPatient.id}`]: true,
    [`Resource?patient=${testPatient.id}`]: true,
    [`Resource?patient=BAD`]: false,
    [`Resource`]: false,
  };

  for (const [path, valid] of Object.entries(cases)) {
    if (valid) {
      await t.step("Accepts ?patient for " + path, async () => {
        const ctx = makeContext(path);
        await fhirRoutes(ctx, next);
        asserts.assert("OK, did not throw");
      });
    } else {
      await t.step("Rejects ?patient for " + path, async () => {
        const ctx = makeContext(path);
        await asserts.assertRejects(async () => {
          await fhirRoutes(ctx, next);
        });
      });
    }
  }

  await t.step("Fails imaging studies with no patient", async () => {
    const ctx = makeContext("/ImagingStudy?");
    await asserts.assertRejects(async () => {
      await fhirRoutes(ctx, next);
    });
  });

  await t.step("Provides imaging studies with correct patient", async () => {
    const ctx = makeContext("/ImagingStudy?patient=" + testPatient.id);
    await fhirRoutes(ctx, next);
    asserts.assertEquals(ctx.response.status, oak.Status.OK);
  });
});
