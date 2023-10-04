// import { Router } from "./deps.ts";

import { Hono, HTTPException } from "./deps.ts";
import { HonoEnv } from "./types.ts";

export const fhirRouter = new Hono<HonoEnv>()
fhirRouter.use("/:fhir{[A-Z][^/]*/*}", async (c, next) => {

  let patient = c.req.query("patient");
  if (patient?.startsWith("Patient/")) {
    patient = patient.split("Patient/")[1];
  }

  if (!c.var.tenantAuthz.disableAuthzChecks && (
    !patient || patient !== c.var.tenantAuthz.patient!.id)) {
    throw new HTTPException(403, { message: 'Patient parameter is required and must match authz context' })
  }

  await next();
});

// deno-lint-ignore require-await
fhirRouter.get("/", async (c) => c.json({
    Welcome: "To the SMART Imaging Access Demo Server",
    Configuration:
      "This Demo hosts many virtual FHIR endpoints with different configurations, to assist in testing. See https://github.com/jmandel/smart-imaging#flexible-behaviors",
    SeeAlso: [`./metadata`, `./ImagingStudy?patient={}`],
}));

// deno-lint-ignore require-await
fhirRouter.get("/metadata", async (c) => c.json({
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    fhirVersion: "4.0.1",
    format: ["json", "application/fhir+json"],
    rest: [
      {
        mode: "server",
        resource: [
          {
            type: "ImagingStudy",
            interaction: [
              {
                code: "search-type",
              },
            ],
            searchInclude: ["*", "ImagingStudy:endpoint"],
            searchParam: [
              {
                name: "patient",
                definition: "http://hl7.org/fhir/SearchParameter/clinical-patient",
                type: "reference",
              },
            ],
          },
        ],
      },
    ],
  }));

fhirRouter.get("/ImagingStudy", async (c) => {
  const { delayed, secondsRemaining } = c.var.tenantImageProvider.delayed("lookup");
  if (delayed) {
    c.res.headers.set("Retry-After", secondsRemaining!.toString());
    c.status(503)
    return;
  }

  const studies = await c.var.tenantImageProvider.lookupStudies(c);
  c.res.headers.set("content-type", "application/fhir+json");
  return c.json(studies)
});
