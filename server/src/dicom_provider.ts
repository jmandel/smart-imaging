import { fhirpath, Hono, HTTPException, jose } from "./deps.ts";
import {
  AppContext,
  FhirResponse,
  HonoEnv,
  QidoResponse,
  QueryRestrictions,
  Reference,
  TAGS,
} from "./types.ts";
import { pathKey } from "./config.ts";

const bindingTokens: Map<string, string> = new Map();
export const createUidBindingToken = async (uid: string, query: QueryRestrictions) => {
  const key = `${uid}|${JSON.stringify(query)}`;
  if (bindingTokens.has(key)) {
    return bindingTokens.get(key);
  }

  const encrypted = await new jose.EncryptJWT({ uid, query })
    .setIssuedAt()
    .setExpirationTime("1 day")
    .setProtectedHeader({alg: "dir", enc: "A256GCM"})
    .encrypt(pathKey);

  bindingTokens.set(key, encrypted);
  return encrypted;
};

export type DicomProviderConfig =
  & {
    lookup:
      | "all-studies-on-server"
      | "studies-by-mrn";
    endpoint: string;
    ae?: string;
    mrn?: string[];
    authentication: {
      type: "http-basic" | "open";
      username: string;
      password: string;
    };
    delay?: {
      lookupUntil?: number;
      retrieveUntil?: number;
    };
  }
  & ({
    type: "dicom-web";
  } | {
    type: "dicom-dimse";
  });

export interface DicomWebResult {
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

export interface StudyEnriched {
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

  return names
    ? names.slice(-1)[0] + " " + names.slice(0, -1).join(" ")
    : undefined;
}

export function formatDate(
  dateString: string,
  timeString?: string,
): string | undefined {
  if (!dateString) return undefined;
  const date = dateString.replace(/(\d{4})(\d{2})(\d{2})/, "$1-$2-$3");
  if (!timeString) return new Date(date).toISOString().slice(0, 10);

  const time = timeString.replace(
    /(\d{2})(\d{2})(\d{2})(\.\d{1,6})?/,
    "$1:$2:$3$4Z",
  );
  return new Date(`${date}T${time}`).toISOString();
}

export async function formatResource(
  studyIn: StudyEnriched,
  patientReference: Reference,
  proxyBaseUrl: string,
  query: QueryRestrictions,
): Promise<FhirResponse["entry"][number]["resource"]> {
  const q = studyIn.studyQido;
  const uid = q[TAGS.STUDY_UID].Value[0];
  const studyDateTime = formatDate(
    q[TAGS.STUDY_DATE]?.Value?.[0],
    q[TAGS.STUDY_TIME]?.Value?.[0],
  );
  return {
    resourceType: "ImagingStudy",
    status: "available",
    id: q[TAGS.STUDY_UID].Value[0],
    subject: {
      ...patientReference,
      display: formatName(q[TAGS.PATIENT_NAME]?.Value?.[0]?.Alphabetic),
    },
    started: studyDateTime,
    referrer: {
      display: formatName(
        q[TAGS.REFERRING_PHYSICIAN_NAME]?.Value?.[0]?.Alphabetic,
      ),
    },
    description: q[TAGS.STUDY_DESCRIPTION]?.Value?.[0] ??
      q[TAGS.MODALITIES_IN_STUDY]?.Value?.join(", "),
    numberOfSeries: q[TAGS.NUMBER_OF_SERIES]?.Value?.[0],
    numberOfInstances: q[TAGS.NUMBER_OF_INSTANCES_IN_STUDY]?.Value?.[0],
    contained: [
      {
        resourceType: "Endpoint",
        id: "e",
        address: `${proxyBaseUrl}/wado/${await createUidBindingToken(uid, query)}`,
        connectionType: {
          system:
            "http://terminology.hl7.org/CodeSystem/endpoint-connection-type",
          code: "dicom-wado-rs",
        },
      },
    ],
    series: studyIn.series?.map((s) => ({
      uid: s.seriesQido[TAGS.SERIES_UID].Value[0],
      number: s.seriesQido[TAGS.SERIES_NUMBER]?.Value?.[0],
      numberOfInstances: s.seriesQido[TAGS.NUMBER_OF_INSTANCES_IN_SERIES]?.Value
        ?.[0],
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
    endpoint: [{ reference: "#e" }],
    identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${uid}` }],
    modality: q[TAGS.MODALITIES_IN_STUDY].Value.map((code: string) => ({
      system: `http://dicom.nema.org/resources/ontology/DCM`,
      code,
    })),
  };
}

type Constructor<T = DicomProvider> = new (config: DicomProviderConfig, proxyBase: string) => T;
const DicomProviderTypes = {} as Record<string, Constructor<DicomProvider>>;

export class DicomProvider {
  static registerType(key: string, constructor: typeof DicomProviderTypes[keyof typeof DicomProviderTypes]) {
    DicomProviderTypes[key] = constructor;
  }
  static create(config: DicomProviderConfig, proxyBase: string) {
    return new DicomProviderTypes[config.type](config, proxyBase) as DicomProvider;
  }
  constructor(public config: DicomProviderConfig, public proxyBase: string) {}
  getSeriesMetadataForStudy(_studyUid: string): Promise<QidoResponse> {
    throw "TODO";
  }
  getInstanceMetadataForSeries(_studyUid: string): Promise<QidoResponse> {
    throw "TODO";
  }
  async enrichStudies(
    studies: QidoResponse,
    // deno-lint-ignore no-unused-vars
    level: "STUDY" | "SERIES" | "INSTANCE" = "SERIES",
  ): Promise<StudyEnriched[]> {
    return await studies.map((studyQido) => ({ studyQido }));
  }

  // deno-lint-ignore no-unused-vars
  async evaluateQido(query: Record<string, string>): Promise<StudyEnriched[]> {
    throw await "abstract";
  }
  async lookupStudies(c: AppContext): Promise<FhirResponse> {
    const { restrictions, query, patientReference } = await this.prepareQuery(
      c,
    );

    const studies = await this.evaluateQido(query);

    return {
      resourceType: "Bundle",
      entry: await Promise.all(
        studies.map(async (study) => ({
          resource: await formatResource(
            study,
            patientReference,
            this.proxyBase,
            restrictions,
          ),
        })),
      ),
    };
  }

  evaluateWado(
    // deno-lint-ignore no-unused-vars
    path: string,
    // deno-lint-ignore no-unused-vars
    reqHeaders: Record<string, string>,
  ): Promise<DicomWebResult> {
    throw "abstract";
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
  async prepareQuery(c: AppContext) {
    const query: Record<string, string> = {};
    const patientReference: Reference = {};

    const restrictions = c.var.query;

    if (this.config.lookup === "studies-by-mrn" && restrictions.byPatientId) {
      const patient = await c.var.authorizer.resolvePatient(
        restrictions.byPatientId,
      );
      const mrnPaths = this.config.mrn ??
        ["identifier.where(type.coding.code='MR').value"];
      const mrn = mrnPaths.map((p) => fhirpath.evaluate(patient, p)[0]).filter((
        x,
      ) => !!x)?.[0] ?? patient?.identifier?.[0]?.value;
      const ehrBase = c.var.tenant?.config?.authorization?.fhirBaseUrl;
      patientReference.reference = (ehrBase ? ehrBase + "/" : "") + "Patient/" +
        patient.id;
      query["PatientID"] = mrn;
    } else if (this.config.lookup === "studies-by-mrn" && restrictions.byPatientIdentifier) {
      const identifier = restrictions.byPatientIdentifier;
      patientReference.identifer = identifier;
      query["PatientID"] = identifier.value;
    }

    return { restrictions, query, patientReference };
  }
}

export const wadoRouter = new Hono<HonoEnv>()
  .use("/:studyPatientBinding/studies/:wadoSuffix{.*}", async (c, next) => {
    const uidParam = c.req.param("wadoSuffix").split("/")[0];

    let token;
    try {
      token = await jose.compactDecrypt(
        c.req.param("studyPatientBinding")!,
        pathKey,
      );
    } catch (e) {
      throw new HTTPException(403, {
        message: "Failed to validate inline token: " + e.message,
      });
    }

    const { uid, query }: { uid: string; query: QueryRestrictions } = JSON
      .parse(
        new TextDecoder().decode(token.plaintext),
      );

    if (uid !== uidParam) {
      throw new HTTPException(403, {
        message: `Study uid mismatch: ${uid} vs ${uidParam}`,
      });
    }

    try {
      await c.var.authorizer.ensureQueryAllowed(query);
    } catch (_e) {
      throw new HTTPException(403, { message: `Query Restrictions Mismatch` });
    }

    await next();
    return;
  })
  .get(
    "/:studyPatientBinding/studies/:wadoSuffix{.*}",
    async (c) => {
      const { delayed, secondsRemaining } = c.var.tenantImageProvider.delayed(
        "retrieve",
      );
      if (delayed) {
        c.res.headers.set("Retry-After", secondsRemaining!.toString());
        c.status(503);
        return c.body(null);
      }

      const { headers, body } = await c.var.tenantImageProvider
        .evaluateWado(
          c.req.param("wadoSuffix"),
          c.req.header(),
        );
      Object.entries(headers).forEach(([k, v]) => {
        c.res.headers.set(k, v);
      });
      return c.body(body);
    },
  );

