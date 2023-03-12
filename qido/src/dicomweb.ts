import { jose, Router } from "./deps.ts";
import { baseUrl } from "./config.ts";
import { Patient,FhirResponse,Identifier,QidoResponse,TAGS, AppState } from "./types.ts";

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

export const dicomWebConfig = {
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

const wadoInnerRouter = new Router().get("/studies/:uid", async (ctx) => {
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

export const wadoRouter = new Router<AppState>()
  .all("/:studyPatientBinding/studies/:uid/(.*)", async (ctx, next) => {
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

  .use("/:studyPatientBinding", wadoInnerRouter.routes());
