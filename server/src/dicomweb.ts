import { jose, Router } from "./deps.ts";
import { AppState, FhirResponse, Identifier, Patient, QidoResponse, TAGS } from "./types.ts";

const ephemeralKey = new Uint8Array(32);
crypto.getRandomValues(ephemeralKey);

const signatures: Map<string, string> = new Map();
export const signStudyUid = async (uid: string, patient?: string) => {
  const key = `${uid}|${patient}`;
  if (signatures.has(key)) {
    return signatures.get(key);
  }

  const ret = await new jose.SignJWT({ uid, patient })
    .setIssuedAt()
    .setExpirationTime("1 day")
    .setProtectedHeader({
      alg: "HS256",
    })
    .sign(ephemeralKey);
  signatures.set(key, ret);
  return ret;
};

export type DicomProviderConfig = {
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

export function formatName(name: string): string | undefined {
  const names = name
    ? name
      .split("^")
      .map((n) => n.trim())
      .filter((n) => !!n)
    : undefined;

  return names ? names.slice(-1)[0] + " " + names.slice(0, -1).join(" ") : undefined;
}

export function formatDate(dateString: string, timeString?: string): string | undefined {
  if (!dateString) return undefined;
  const date = dateString.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  if (!timeString) return new Date(date).toISOString().slice(0, 10);

  const time = timeString.replace(/(\d{2})(\d{2})(\d{2})(\.\d{1,6})?/, "$1:$2:$3$4Z");
  return new Date(`${date}T${time}`).toISOString();
}

async function formatResource(
  q: QidoResponse[number],
  patientId: string | undefined,
  wadoBase: string,
): Promise<FhirResponse["entry"][number]["resource"]> {
  const uid = q[TAGS.STUDY_UID].Value[0];
  const studyDateTime = formatDate(q[TAGS.STUDY_DATE].Value?.[0], q[TAGS.STUDY_TIME].Value?.[0]);

  return {
    resourceType: "ImagingStudy",
    status: "available",
    id: q[TAGS.STUDY_UID].Value[0],
    subject: {
      display: formatName(q[TAGS.PATIENT_NAME]?.Value?.[0]?.Alphabetic),
      reference: patientId ? `Patient/${patientId}` : undefined,
    },
    started: studyDateTime,
    referrer: {
      display: formatName(q[TAGS.REFERRING_PHYSICIAN_NAME]?.Value?.[0]?.Alphabetic),
    },
    description: q[TAGS.STUDY_ID]?.Value?.[0],
    numberOfSeries: q[TAGS.NUMBER_OF_SERIES]?.Value?.[0],
    numberOfInstances: q[TAGS.NUMBER_OF_INSTANCES]?.Value?.[0],
    contained: [
      {
        resourceType: "Endpoint",
        id: "e",
        address: `${wadoBase}/${await signStudyUid(uid, patientId)}`,
        connectionType: {
          system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
          code: "dicom-wado-rs",
        },
      },
    ],
    endpoint: { reference: "#e" },
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
    modality: q[TAGS.MODALITIES_IN_STUDY].Value.map((code: string) => ({
      system: `http://dicom.nema.org/resources/ontology/DCM`,
      code,
    })),
  };
}

export class DicomProvider {
  constructor(public config: DicomProviderConfig, public wadoBase: string) {}
  authHeader() {
    return `Basic ${
      btoa(`${this.config.authentication.username}:${this.config.authentication.password}`)
    }`;
  }
  async evaluateDicomWeb(path: string, reqHeaders: Headers): Promise<DicomWebResult> {
    const proxied = await fetch(`${this.config.endpoint}/studies/${path}`, {
      headers: {
        authorization: this.authHeader(),
        accept: reqHeaders.get("accept") ||
          `multipart/related; type=application/dicom; transfer-syntax=*`,
      },
    });
    const headers: Record<string, string> = {};
    headers["cache-control"] = "private, max-age=3600";
    ["content-type", "content-length"].map((h) => {
      if (proxied.headers.get(h)) {
        headers[h] = proxied.headers.get(h)!;
      }
    });
    return { headers, body: proxied.body! };
  }

  async lookupStudies(patient?: Patient): Promise<FhirResponse> {
    let query = ``;
    if (this.config.lookup === "studies-by-mrn" && patient) {
      const mrnIdentifier = patient.identifier.filter((i: Identifier) =>
        i?.type?.coding?.some((c) => c.code === "MR")
      );
      const mrn = mrnIdentifier[0].value;
      console.log("MRN", mrn);
      query = `PatientID=${mrn}`;
    }
    const qido = new URL(`${this.config.endpoint}/studies?${query}`);
    // console.log("Q", qido);
    const studies: QidoResponse = await fetch(qido, {
      headers: {
        authorization: this.authHeader(),
      },
    }).then((q) => q.json());
    return {
      resourceType: "Bundle",
      entry: await Promise.all(
        studies.map(async (q) => ({
          resource: await formatResource(q, patient?.id, this.wadoBase),
        })),
      ),
    };
  }
}

const wadoInnerRouter = new Router<AppState>().get("/studies/:uid(.*)", async (ctx) => {
  const { headers, body } = await ctx.state.imagesProvider.evaluateDicomWeb(
    `${ctx.params.uid}`,
    ctx.request.headers,
  );
  Object.entries(headers).forEach(([k, v]) => {
    ctx.response.headers.set(k, v);
  });
  ctx.response.body = body;
});

export const wadoRouter = new Router<AppState>()
  .all("/:studyPatientBinding/studies/:uid/(.*)?", async (ctx, next) => {
    const token = await jose.compactVerify(ctx.params.studyPatientBinding, ephemeralKey);
    const { uid, patient }: { uid: string; patient: string } = JSON.parse(
      new TextDecoder().decode(token.payload),
    );

    if (ctx.state.disableAccessControl) {
      return next();
    }

    if (patient !== ctx.state.authorizedForPatient!.id) {
      throw `Patient mismatch: ${patient} vs ${ctx.state.authorizedForPatient!.id}`;
    }
    if (uid !== ctx.params.uid) {
      throw `Study uid mismatch: ${uid} vs ${ctx.params.uid}`;
    }

    console.log("SPB", ctx.params.studyPatientBinding, ctx.state);
    await next();
  })
  .use("/:studyPatientBinding", wadoInnerRouter.routes());
