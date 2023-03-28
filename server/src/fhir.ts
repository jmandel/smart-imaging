import { Router } from "./deps.ts";
import { AppState } from "./types.ts";
import { routerOpts} from "./config.ts";

export const fhirRouter = new Router<AppState>(routerOpts);
fhirRouter.all("/:fhir([A-Z].*)", async (ctx, next) => {
  console.log("frpath", ctx.params)
  let patient = ctx.request.url.searchParams.get("patient");
  if (patient?.startsWith("Patient/")) {
    patient = patient.split("Patient/")[1];
  }

  if (ctx.state.disableAccessControl) {
    return await next();
  }
  if (!patient || patient !== ctx.state.authorizedForPatient!.id) {
    throw `Patient parameter is required and must match authz context`;
  }
  await next();
});

// deno-lint-ignore require-await
fhirRouter.get("/", async (ctx) => {
  ctx.response.body = {
    Welcome: "To the SMART Imaging Access Demo Server",
    Configuration: "This Demo hosts many virtual FHIR endpoints with different configurations, to assist in testing. See https://github.com/jmandel/smart-imaging#flexible-behaviors",
    SeeAlso: [`./metadata`, `./ImagingStudy?patient={}`]
  };
});

// deno-lint-ignore require-await
fhirRouter.get("/metadata", async (ctx) => {
  ctx.response.body = {
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
  };
});

fhirRouter.get("/ImagingStudy", async (ctx) => {
  const patient = ctx.request.url.searchParams.get("patient");
  if (!patient) {
    throw "Need a Patient";
  }
  const p = ctx.state.authorizedForPatient;
  const studies = await ctx.state.imagesProvider.lookupStudies(p);
  ctx.response.headers.set("content-type", "application/fhir+json");
  ctx.response.body = JSON.stringify(studies, null, 2);
});
