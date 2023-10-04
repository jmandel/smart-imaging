import { fhirpath, Hono, HTTPException, jose } from "./deps.ts";
import {
  AppContext,
  FhirResponse,
  HonoEnv,
  QidoResponse,
  TAGS
} from "./types.ts";

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
  delay?: {
    lookupUntil?: number;
    retrieveUntil?: number;
  };
  lookup: "studies-by-mrn" | "all-studies-on-server" | "studies-by-identifier";
  mrn?: string[];
  endpoint: string;
  authentication: {
    type: "http-basic" | "open";
    username: string;
    password: string;
  };
};

interface DicomWebResult {
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

interface StudyEnriched {
  studyQido: QidoResponse[number];
  series?: { seriesQido: QidoResponse[number]; instances?: QidoResponse }[];
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
  studyIn: StudyEnriched,
  patientId: string | undefined,
  proxyBaseUrl: string,
  ehrBaseUrl?: string,
): Promise<FhirResponse["entry"][number]["resource"]> {
  const q = studyIn.studyQido;
  const uid = q[TAGS.STUDY_UID].Value[0];
  const studyDateTime = formatDate(q[TAGS.STUDY_DATE].Value?.[0], q[TAGS.STUDY_TIME].Value?.[0]);
  return {
    resourceType: "ImagingStudy",
    status: "available",
    id: q[TAGS.STUDY_UID].Value[0],
    subject: {
      display: formatName(q[TAGS.PATIENT_NAME]?.Value?.[0]?.Alphabetic),
      reference: patientId ? `${ehrBaseUrl ?? ""}/Patient/${patientId}` : undefined,
    },
    started: studyDateTime,
    referrer: {
      display: formatName(q[TAGS.REFERRING_PHYSICIAN_NAME]?.Value?.[0]?.Alphabetic),
    },
    description: q[TAGS.STUDY_DESCRIPTION]?.Value?.[0] ??
      q[TAGS.MODALITIES_IN_STUDY]?.Value?.join(", "),
    numberOfSeries: q[TAGS.NUMBER_OF_SERIES]?.Value?.[0],
    numberOfInstances: q[TAGS.NUMBER_OF_INSTANCES_IN_STUDY]?.Value?.[0],
    contained: [
      {
        resourceType: "Endpoint",
        id: "e",
        address: `${proxyBaseUrl}/wado/${await signStudyUid(uid, patientId)}`,
        connectionType: {
          system: "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
          code: "dicom-wado-rs",
        },
      },
    ],
    series: studyIn.series?.map((s) => ({
      uid: s.seriesQido[TAGS.SERIES_UID].Value[0],
      number: s.seriesQido[TAGS.SERIES_NUMBER]?.Value?.[0],
      numberOfInstances: s.seriesQido[TAGS.NUMBER_OF_INSTANCES_IN_SERIES]?.Value?.[0],
      title: s.seriesQido[TAGS.SERIES_DESCRIPTION]?.Value?.[0],
      modality: s.seriesQido[TAGS.MODALITY]?.Value?.map((code: string) => ({
        system: `http://dicom.nema.org/resources/ontology/DCM`,
        code,
      }))[0],
      instance: s.instances?.map((i) => ({
        uid: i[TAGS.SOP_INSTANCE_UID].Value[0],
        number: i[TAGS.INSTANCE_NUMBER]?.Value?.[0],
        sopClass: {
          system: "urn:ietf:rfc:3986",
          code: `urn:oid:${i[TAGS.SOP_CLASS_UID].Value[0]}`,
        },
      })),
    })),
    endpoint: { reference: "#e" },
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
    modality: q[TAGS.MODALITIES_IN_STUDY].Value.map((code: string) => ({
      system: `http://dicom.nema.org/resources/ontology/DCM`,
      code,
    })),
  };
}

export class DicomProvider {
  constructor(public config: DicomProviderConfig, public proxyBase: string) {}
  authHeader(): HeadersInit {
    if (this.config.authentication.type === "open") {
      return {}
    }
    return  {
      "authorization": `Basic ${ btoa(`${
        this.config.authentication.username
      }:${
        this.config.authentication.password}`)}`
    }
  }
  delayed(activity: "lookup" | "retrieve") {
    const configKey = (activity + "Until") as "lookupUntil" | "retrieveUntil";
    const delayUntil = this.config?.delay?.[configKey];
    if (delayUntil) {
      const delayRemaining = delayUntil - new Date().getTime() / 1000;
      if (delayRemaining > 0) {
        return { delayed: true, secondsRemaining: delayRemaining };
      }
    }
    return { delayed: false };
  }
  async evaluateDicomWeb(
    path: string,
    reqHeaders: Record<string, string>,
  ): Promise<DicomWebResult> {
    const proxied = await fetch(`${this.config.endpoint}/studies/${path}`, {
      headers: {
        ...this.authHeader(),
        accept: reqHeaders["accept"] ||
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

  async lookupStudies(c: AppContext): Promise<FhirResponse> {
    const { patient, ehrBaseUrl } = c.var.tenantAuthz;

    const query: Record<string, string> = {
      includefield: "StudyDescription",
    };
    if (this.config.lookup === "studies-by-mrn" && patient) {
      const mrnPaths = this.config.mrn ?? ["identifier.where(type.coding.code='MR').value"];
      const mrn = mrnPaths.map((p) => fhirpath.evaluate(patient, p)[0]).filter((x) => !!x)?.[0];
      query["PatientID"] = mrn;
    } else if (this.config.lookup === "studies-by-identifier") {
      const identifier = (
        c.req.query("patient.identifier") ??
          c.req.query("subject.identifier")
      )
        ?.split("|")?.slice(-1)?.[0];
      if (!identifier) {
        throw new HTTPException(403, {
          message: `Cannot query by identifier without a valid identifier`,
        });
      }
      query["PatientID"] = identifier;
    }
    const qido = new URL(
      `${this.config.endpoint}/studies?${new URLSearchParams(query).toString()}`,
    );

    const matchingStudies: QidoResponse = await fetch(qido, {
      headers: {
        ...this.authHeader()
      },
    }).then((q) => q.json());

    const studies = await this.enrichStudies(matchingStudies);

    return {
      resourceType: "Bundle",
      entry: await Promise.all(
        studies.map(async (study) => ({
          resource: await formatResource(study, patient?.id, this.proxyBase, ehrBaseUrl),
        })),
      ),
    };
  }

  async enrichStudies(
    studies: QidoResponse,
    level: "STUDY" | "SERIES" | "INSTANCE" = "SERIES",
  ): Promise<StudyEnriched[]> {
    return await Promise.all(studies.map(async (studyQido) => {
      let seriesToReturn: StudyEnriched["series"] = [];
      if (level !== "STUDY") {
        const seriesForStudy: QidoResponse = await fetch(
          `${this.config.endpoint}/studies/${studyQido[TAGS.STUDY_UID].Value[0]}/series`,
          {
            headers: this.authHeader(),
          },
        ).then((q) => q.json());

        seriesToReturn = await Promise.all(seriesForStudy.map(async (seriesQido) => {
          let instancesForSeries: QidoResponse = [];
          if (level === "INSTANCE") {
            instancesForSeries = await fetch(
              `${this.config.endpoint}/studies/${studyQido[TAGS.STUDY_UID].Value[0]}/series/${
                seriesQido[TAGS.SERIES_UID].Value[0]
              }/instances`,
              {
                headers: this.authHeader(),
              },
            ).then((q) => q.json());
          }
          return { seriesQido, instances: level === "INSTANCE" ? instancesForSeries : undefined };
        }));
      }

      return { studyQido, series: level !== "STUDY" ? seriesToReturn : undefined };
    }));
  }
}

export const wadoRouter = new Hono<HonoEnv>()
  .use("/:studyPatientBinding/studies/:wadoSuffix{.*}", async (c, next) => {
    const uidParam = c.req.param("wadoSuffix").split("/")[0];
    if (c.var.tenantAuthz.disableAuthzChecks) {
      await next();
      return;
    }

    let token;
    try {
      token = await jose.compactVerify(c.req.param("studyPatientBinding")!, ephemeralKey);
    } catch (e) {
      throw new HTTPException(403, { message: "Failed to validate inline token: " + e.message });
    }

    const { uid, patient }: { uid: string; patient: string } = JSON.parse(
      new TextDecoder().decode(token.payload),
    );

    if (patient !== c.var.tenantAuthz.patient!.id) {
      throw new HTTPException(403, {
        message: `Patient mismatch: ${patient} vs ${c.var.tenantAuthz.patient!.id}`,
      });
    }
    if (uid !== uidParam) {
      throw new HTTPException(403, { message: `Study uid mismatch: ${uid} vs ${uidParam}` });
    }

    await next();
    return;
  })
  .get("/:studyPatientBinding/studies/:wadoSuffix{.*}", async (c: AppContext) => {
    const { delayed, secondsRemaining } = c.var.tenantImageProvider.delayed("retrieve");
    if (delayed) {
      c.res.headers.set("Retry-After", secondsRemaining!.toString());
      c.status(503);
      return;
    }

    const { headers, body } = await c.var.tenantImageProvider.evaluateDicomWeb(
      c.req.param("wadoSuffix"),
      c.req.header(),
    );
    Object.entries(headers).forEach(([k, v]) => {
      c.res.headers.set(k, v);
    });
    return c.body(body);
  });
