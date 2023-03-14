import { jose, Router } from "./deps.ts";
import { AppState, FhirResponse, Identifier, Patient, QidoResponse, TAGS } from "./types.ts";

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

type DicomProviderConfig = {
  type: "dicom-web";
  lookup: "studies-by-mrn" | "all-studies-on-server";
  endpoint: string;
  authentication: {
    type: "http-basic";
    username: string;
    password: string;
  };
};

interface DicomWebResult {
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

export class DicomProvider {
  constructor(public config: DicomProviderConfig, public wadoBase: string) {}
  authHeader() {
    return `Basic ${
      btoa(`${this.config.authentication.username}:${this.config.authentication.password}`)
    }`;
  }
  async evaluateDicomWeb(path: string): Promise<DicomWebResult> {
    const proxied = await fetch(`${this.config.endpoint}/studies/${path}`, {
      headers: {
        authorization: this.authHeader(),
      },
    });
    const headers: Record<string, string> = {};
    ["content-type", "content-length"].map((h) => {
      if (proxied.headers.get(h)) {
        headers[h] = proxied.headers.get(h)!;
      }
    });

    return { headers, body: proxied.body! };
  }

  async lookupStudies(patient: Patient): Promise<FhirResponse> {
    let query = ``;
    if (this.config.lookup === "studies-by-mrn") {
      const mrnIdentifier = patient.identifier.filter((i: Identifier) =>
        i?.type?.text?.match("Medical Record Number")
      );
      const mrn = mrnIdentifier[0].value;
      console.log("MRN", mrn);
      query = `PatientID=${mrn}`;
    }
    const qido = new URL(`${this.config.endpoint}/studies?${query}`);
    console.log("Q", qido)
    const studies: QidoResponse = await fetch(qido, {
      headers: {
        authorization: this.authHeader(),
      },
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
                  address: `${this.wadoBase}/${await signStudyUid(uid, patient.id)}/studies/${uid}`,
                },
              ],
              endpoint: { reference: "#e" },
              identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
              modality: modality.map((code) => ({
                system: `http://dicom.nema.org/resources/ontology/DCM`,
                code,
              })),
            },
          };
        }),
      ),
    };
  }
}

const wadoInnerRouter = new Router<AppState>().get("/studies/:uid(.*)", async (ctx) => {
  const { headers, body } = await ctx.state.imagesProvider.evaluateDicomWeb(`${ctx.params.uid}`);
  Object.entries(headers).forEach(([k, v]) => {
    ctx.response.headers.set(k, v);
  });
  ctx.response.body = body;
});

export const wadoRouter = new Router<AppState>()
  .all("/:studyPatientBinding/studies/:uid/(.*)", async (ctx, next) => {
    const token = await jose.compactVerify(ctx.params.studyPatientBinding, ephemeralKey);
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
