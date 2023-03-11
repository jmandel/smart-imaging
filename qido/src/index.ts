import { Application, jose, Router } from "./deps.ts";

import { AppState, FhirResponse, Identifier, Patient, QidoResponse, TAGS } from "./types.ts";

const app = new Application<AppState>();

const defaultFhirClinicalServer = `https://launch.smarthealthit.org/v/r4/fhir`;
const fhirClinicalServer = defaultFhirClinicalServer;

const ephemeralKey = new Uint8Array(32);
crypto.getRandomValues(ephemeralKey);

const signStudyUid = async (uid: string, patient: string) => {
  return await new jose.SignJWT({ uid, patient })
    .setIssuedAt()
    .setExpirationTime("1 day")
    .setProtectedHeader({
      alg: "HS256",
    })
    .sign(ephemeralKey);
};

const dicomWebConfig = {
  baseUrl: `http://localhost:8042/dicom-web`,
  headers: { authorization: `Basic ${btoa(`orthanc:orthanc`)}` },
  lookupStudies: async (patient: Patient): Promise<FhirResponse> => {
    const mrnIdentifier = patient.identifier.filter((i: Identifier) =>
      i?.type?.text?.match("Medical Record Number")
    );
    const mrn = mrnIdentifier[0].value;
    console.log("MRN", mrn);

    const qido = new URL(`${dicomWebConfig.baseUrl}/studies?PatientId=${mrn}`);
    const studies: QidoResponse = await fetch(qido, {
      headers: dicomWebConfig.headers,
    }).then((q) => q.json());

    console.log("s", studies);
    return {
      resourceType: "Bundle",
      entry: await Promise.all(
        studies.map(async (q) => {
          const uid = q[TAGS.STUDY_UID].Value[0];
          const modality = q[TAGS.MODALITY].Value;
          return {
            resource: {
              resourceType: "ImagingStudy",
              status: "available",
              id: uid,
              contained: [
                {
                  resourceType: "Endpoint",
                  id: "e",
                  address: `${baseUrl}/wado/${await signStudyUid(
                    uid,
                    patient.id,
                  )}/studies/${uid}`,
                },
              ],
              endpoint: { reference: "#e" },
              identifier: [
                { system: "urn:dicom:uid", value: `urn:oid:${uid}` },
              ],
              modality: modality.map((code) => ({
                system: `http://dicom.nema.org/resources/ontology/DCM`,
                code,
              })),
            },
          };
        }),
      ),
    };
  },
};

const defaultPort = 8000;
const port = parseInt(
  (Deno.permissions.querySync({ name: "env", variable: "PORT" }).state ===
      "granted" &&
    Deno.env.get("PORT")) ||
    defaultPort.toString(),
);

const baseUrl = `http://localhost:${port}`;

type DicomQuery = { type: "qido"; params: { PatientId: string } };

type LookupPatient = (pid: string) => Promise<Patient>;

const lookupPatientSandbox: LookupPatient = async (
  patient: string,
): Promise<Patient> => {
  if (!patient?.startsWith("Patient/")) {
    patient = `Patient/${patient}`;
  }

  const patientDetails = await fetch(`${fhirClinicalServer}/${patient}`).then(
    (r) => r.json(),
  );

  return patientDetails;
};

const fhirRouter = new Router<typeof app.state>();
fhirRouter.all("/:any*", async (ctx, next) => {
  let patient = ctx.request.url.searchParams.get("patient");
  if (patient?.startsWith("Patient/")) {
    patient = patient.split("Patient/")[1];
  }
  if (!patient || patient !== ctx.state.authorizedForPatient.id) {
    throw `Patient parameter is required and must match authz context`;
  }
  await next();
});

fhirRouter.get("/ImagingStudy", async (ctx) => {
  const patient = ctx.request.url.searchParams.get("patient");
  if (!patient) {
    throw "Need a Patient";
  }
  const p = await lookupPatientSandbox(patient);
  const studies = await dicomWebConfig.lookupStudies(p);
  ctx.response.headers.set("content-type", "application/fhir+json");
  ctx.response.body = JSON.stringify(studies, null, 2);
});

const wadoRouter = new Router().get("/studies/:uid", async (ctx) => {
  const proxied = await fetch(
    `${dicomWebConfig.baseUrl}/studies/${ctx.params.uid}`,
    {
      headers: dicomWebConfig.headers,
    },
  );
  ["content-type", "content-length"].map((h) => {
    if (proxied.headers.get(h)) {
      ctx.response.headers.append(h, proxied.headers.get(h)!);
    }
  });
  ctx.response.body = proxied.body;
});

import { resolve } from "https://deno.land/std@0.179.0/path/mod.ts";
import { Introspection } from "./introspection.ts";
const tenantConfig = new Map<string, unknown>();
for (const f of Deno.readDirSync("config")) {
  if (f.name.match(/\.json$/)) {
    tenantConfig.set(
      f.name.replace(/\.json$/, ""),
      JSON.parse(Deno.readTextFileSync(resolve("config", f.name))),
    );
  }
}

const multiTenantRouter = new Router<AppState>();
multiTenantRouter.all(
  "/:dyn(dyn)?/:tenant/(fhir|wado)/(.*)",
  async (ctx, next) => {
    console.log("multitenant", ctx.params, ctx.request.url.pathname);
    const tenantKey = ctx.params.tenant;
    let tenant;
    if (ctx.params.dyn) {
      tenant = JSON.parse(
        new TextDecoder().decode(jose.base64url.decode(tenantKey)),
      );
    } else {
      tenant = tenantConfig.get(tenantKey);
    }
    console.log("Tenant", tenant);
    const authzForTenant = Introspection.create(tenant.authorization);
    await authzForTenant.assignAuthorization(ctx);
    console.log("Authzd", ctx.state);

    //   const accessToken = ctx.request.headers.get("authorization")!;
    //   const introspectionResponse = await introspect(accessToken);
    //   const patient = await lookupPatientSandbox(introspectionResponse.patient);
    //   ctx.state.authorizedForPatient = patient;
    await next();
  },
);

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    console.log("Err", e);
    ctx.response.status = 500;
    ctx.response.body = e.toString();
  }
});

const wadoSubRouter = new Router<typeof app.state>()
  .all("/:studyPatientBinding/studies/:uid/:suffix*", async (ctx, next) => {
    const token = await jose.compactVerify(
      ctx.params.studyPatientBinding,
      ephemeralKey,
    );
    const { uid, patient }: { uid: string; patient: string } = JSON.parse(
      new TextDecoder().decode(token.payload),
    );
    if (patient !== ctx.state.authorizedForPatient.id) {
      throw `Patient mismatch: ${patient} vs ${ctx.state.authorizedForPatient.id}`;
    }
    if (uid !== ctx.params.uid) {
      throw `Study uid mismatch: ${uid} vs ${ctx.params.uid}`;
    }

    console.log("SPB", ctx.params.studyPatientBinding, ctx.state);
    await next();
  })
  .use("/:studyPatientBinding", wadoRouter.routes());

multiTenantRouter.use("/:dyn(dyn)?/:tenant/fhir", fhirRouter.routes());
multiTenantRouter.use("/:dyn(dyn)?/:tenant/wado", wadoSubRouter.routes());
app.use(multiTenantRouter.routes());

console.log("START", port);
await app.listen({ port });
