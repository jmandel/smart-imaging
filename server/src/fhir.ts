// import { Router } from "./deps.ts";

import { Hono, HTTPException, cors } from "./deps.ts";
import { AppContext, HonoEnv, Identifier, IntrospectionConfig, QueryRestrictions, isIndependentSmartTenant } from "./types.ts";

export const fhirRouter = new Hono<HonoEnv>();

// Add CORS middleware at the top level
fhirRouter.use("*", cors({
  origin: "*", // You might want to restrict this based on your needs
  allowMethods: ["GET", "POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  credentials: true,
  maxAge: 3600,
}));

fhirRouter.use("/:fhir{[A-Z][^/]*/*}", async (c, next) => {
  const tenantKey = c.var.tenant.key;
  const queryRestrictions: QueryRestrictions = { tenantKey };

  let patient = c.req.query("patient") ?? c.req.query("subject");
  const patientIdentifierInput = c.req.query("patient.identifier") ??
    c.req.query("subject.identifier");

  if (patient) {
    if (patient?.startsWith("Patient/")) {
      patient = patient.split("Patient/")[1];
    }
    queryRestrictions.byPatientId = patient;
  }
  if (patientIdentifierInput) {
    const patientIdentifierInputParts = patientIdentifierInput.split("|");
    const patientIdentifier: Identifier = patientIdentifierInputParts.length === 2
      ? {
        system: patientIdentifierInputParts[0],
        value: patientIdentifierInputParts[1],
      }
      : {
        value: patientIdentifierInputParts[0],
      };
    queryRestrictions.byPatientIdentifier = patientIdentifier;
  }

  try {
    await c.var.authorizer.ensureQueryAllowed(queryRestrictions);
  } catch (_e) {
    throw new HTTPException(403, {
      message: "Patient parameter is required and must match authz context",
    });
  }

  c.set("query", queryRestrictions);
  await next();
});
fhirRouter.use('*', async (ctx, next) => {
    console.log("Query Restriction", ctx.var.query)
    await next();
  })



fhirRouter.get("/.well-known/smart-configuration", async (c, next) => {
  if (!isIndependentSmartTenant(c.var.tenant)) {
    return await next();
  }

  const baseUrl = c.var.tenant.baseUrl;
  
  return c.json({
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    grant_types_supported: ["authtenantAuthzConfigorization_code"],
    scopes_supported: [
      "patient/ImagingStudy.rs",
      "launch/patient",
      "launch"
    ],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    capabilities: [
      "launch-standalone",
      "client-public",
      "client-confidential-asymmetric",  // Changed from symmetric to asymmetric
      "permission-patient",
      "permission-v2",
      "context-standalone-patient",
      "smart-imaging-access-dual-launch"
    ]
  });
});

// deno-lint-ignore require-await
fhirRouter.get("/", async (c) =>
  c.json({
    Welcome: "To the SMART Imaging Access Demo Server",
    Configuration:
      "This Demo hosts many virtual FHIR endpoints with different configurations, to assist in testing. See https://github.com/jmandel/smart-imaging#flexible-behaviors",
    SeeAlso: [`./metadata`, `./ImagingStudy?patient={}`],
  }));

// deno-lint-ignore require-await
fhirRouter.get("/metadata", async (c) =>
  c.json({
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
    c.status(503);
    return;
  }

  const studies = await c.var.tenantImageProvider.lookupStudies(c as unknown as AppContext);
  c.res.headers.set("content-type", "application/fhir+json");
  return c.json(studies);
});
