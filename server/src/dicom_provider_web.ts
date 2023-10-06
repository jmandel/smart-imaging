import { DicomProvider, DicomWebResult, StudyEnriched } from "./dicom_provider.ts";
import { QidoResponse, TAGS } from "./types.ts";

export class DicomProviderWeb extends DicomProvider {
  authHeader(): HeadersInit {
    if(this.config.authentication.type === "open") {
      return {};
    }
    return {
      "authorization": `Basic ${btoa(`${this.config.authentication.username}:${this.config.authentication.password}`)}`,
    };
  }

  async evaluateWado(
    path: string,
    reqHeaders: Record<string, string>
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
      if(proxied.headers.get(h)) {
        headers[h] = proxied.headers.get(h)!;
      }
    });
    return { headers, body: proxied.body! };
  }
  async evaluateQido(query: Record<string,string>): Promise<QidoResponse> {
    query["includefield"] = "StudyDescription"
    const qido = new URL(
      `${this.config.endpoint}/studies?${new URLSearchParams(query).toString()}`
    );

    const matchingStudies: QidoResponse = await fetch(qido, {
      headers: {
        ...this.authHeader(),
      },
    }).then((q) => q.json());
    return matchingStudies;
  }

  async enrichStudies(
    studies: QidoResponse,
    level: "STUDY" | "SERIES" | "INSTANCE" = "SERIES"
  ) {
    return await Promise.all(studies.map(async (studyQido) => {
      let seriesToReturn: StudyEnriched["series"] = [];
      if(level !== "STUDY") {
        const seriesForStudy: QidoResponse = await fetch(
          `${this.config.endpoint}/studies/${studyQido[TAGS.STUDY_UID].Value[0]}/series`,
          {
            headers: this.authHeader(),
          }
        ).then((q) => q.json());
        seriesToReturn = await Promise.all(seriesForStudy.map(async (seriesQido) => {
          let instancesForSeries: QidoResponse = [];
          if(level === "INSTANCE") {
            instancesForSeries = await fetch(
              `${this.config.endpoint}/studies/${studyQido[TAGS.STUDY_UID].Value[0]}/series/${seriesQido[TAGS.SERIES_UID].Value[0]}/instances`,
              {
                headers: this.authHeader(),
              }
            ).then((q) => q.json());
          }
          return { seriesQido, instances: level === "INSTANCE" ? instancesForSeries : undefined };
        }));
      }
      return { studyQido, series: level !== "STUDY" ? seriesToReturn : undefined };
    }));
  }
}

DicomProvider.registerType("dicom-web", DicomProviderWeb)