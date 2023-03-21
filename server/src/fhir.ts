import { Router } from "./deps.ts";
import { AppState } from "./types.ts";

export const fhirRouter = new Router<AppState>();
fhirRouter.all("/(.*)", async (ctx, next) => {
  let patient = ctx.request.url.searchParams.get("patient");
  if (patient?.startsWith("Patient/")) {
    patient = patient.split("Patient/")[1];
  }

  if (ctx.state.disableSecurity) {
    return next()
  }
  if (!patient || patient !== ctx.state.authorizedForPatient!.id) {
    throw `Patient parameter is required and must match authz context`;
  }
  await next();
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
