import { move } from "https://deno.land/std@0.180.0/fs/move.ts";
import { dimseDir, dimsePort } from "./config.ts";
import { path } from "./deps.ts";
import {
  DicomProvider,
  DicomProviderConfig,
  DicomWebResult,
  StudyEnriched,
} from "./dicom_provider.ts";
import { QidoResponse, TAGS} from "./types.ts";

import { EventEmitter } from "node:events";

class Study {
  public readersCount = 0;
  public eventEmitter: EventEmitter;
  private allFilesDownloaded = false;
  public downloadDir: string;
  public lastRequestTime: number = new Date().getTime();
  private fileWatcher: Deno.FsWatcher | undefined;
  initialized: Promise<true>;
  moveCommand: Deno.ChildProcess|undefined;

  constructor(public studyUid: string, public config: DicomProviderConfig) {
    this.studyUid = studyUid;
    this.eventEmitter = new EventEmitter();
    this.downloadDir = path.join(dimseDir, studyUid);
    this.addReader();
    this.initialized = new Promise((resolve, _reject) => {
      this.beginMove(resolve);
    });
  }

  async beginMove(resolve: (value: true) => void) {
    try {
      await Deno.stat(path.join(this.downloadDir, ".study-complete"));
      this.allFilesDownloaded = true;
      resolve(true);
    } catch {}

    // deno-lint-ignore no-this-alias
    const study = this;
    const { hostname: endpointHost, port: endpointPort } = new URL(
      this.config.endpoint.replace("dimse://", "https://"),
    );

    await Deno.mkdirSync(study.downloadDir, { recursive: true });
    const moveCommand = new Deno.Command("movescu", {
      args: [
        "--log-level", "debug",
        "-S",
        "-aet",
        this.config.ae!,
        "-k",
        `0020,000D=${this.studyUid}`,
        endpointHost,
        endpointPort,
      ],
    }).spawn();
    this.moveCommand = moveCommand;

    moveCommand.status.then(async s => {
      if (s.success) {
        await Deno.writeTextFile(path.join(this.downloadDir, ".study-complete"), "");
        this.allFilesDownloaded = true;
        console.log("Wrote study complete", this.studyUid)
      } else {
        console.log("Move command failed", s)
        this.eventEmitter.emit("move-failed", {error: s, "description": "Move command failed"});
      }
    })
    resolve(true);
    study.fileWatcher = Deno.watchFs(study.downloadDir);
    for await (const fileChanges of study.fileWatcher) {
      if (fileChanges.kind !== "create" && fileChanges.kind !== "modify") {
        continue;
      }
      for (const fp of fileChanges.paths) {
        if (fp.endsWith(".study-complete")) {
          study.studyReady();
        } else if (
          fileChanges.kind === "modify" && fp.endsWith(".complete")
        ) {
          study.fileReady(fp);
        }
      }
    }
    this.eventEmitter.emit("moving");
  }

  fileReady(f: string) {
    this.eventEmitter.emit("file-ready", { study: this, file: f });
  }

  studyReady() {
    this.allFilesDownloaded = true;
    console.log("Study ready, emitting", this)
    this.eventEmitter.emit("study-ready", { study: this });
  }

  addReader() {
    this.readersCount++;
    this.lastRequestTime = new Date().getTime();
  }

  removeReader() {
    if (this.readersCount > 0) {
      this.readersCount--;
      if (this.readersCount === 0) {
        try {
          this.fileWatcher?.close();
        } catch {}

        this.eventEmitter.emit("no-readers-remain", { study: this });
      }
    }
  }

  async *files(): AsyncGenerator<string> {
    // deno-lint-ignore no-this-alias
    const study: Study = this;
    await study.initialized;
    const yieldedFiles: Record<string, boolean> = {};
    const newFiles = async function* () {
      for await (const f of Deno.readDir(study.downloadDir)) {
        if (f.isFile && f.name.endsWith(".complete")) {
          const p = path.join(study.downloadDir, f.name);
          if (!yieldedFiles[p]) {
            yieldedFiles[p] = true;
            yield p;
          }
        }
      }
    };

    yield* newFiles();

    if (this.allFilesDownloaded) {
      console.log("All fils alredy dl'd, skipping")
    } else {
      console.log("Still waiting on files here", study)
    }
    while (!this.allFilesDownloaded) {
      let resolveHandler;
      const result: any = await new Promise((resolve, _reject) => {
        resolveHandler = (result: any) => {
          this.eventEmitter.off("file-ready", resolveHandler!);
          this.eventEmitter.off("study-ready", resolveHandler!);
          this.eventEmitter.off("move-failed", resolveHandler!);
          resolve(result);
        };
        this.eventEmitter.once("file-ready", resolveHandler);
        this.eventEmitter.once("study-ready", resolveHandler);
        this.eventEmitter.once("move-failed", resolveHandler);
      });

      console.log("Result", result)
      if (result.error) {
        console.log("Throw", result.error)
        throw result.error
      }

      if (result.file) {
        const p = result.file;
        if (!yieldedFiles[p]) {
          yieldedFiles[p] = true;
          yield p;
        }
      }
    }
    console.log("Final sweep")

    yield* newFiles();
  }
}

class StudyDownloadManager {
  private studies: Map<string, Study> = new Map();
  private storeScp: Deno.ChildProcess;
  constructor(dimseDir: string) {
    Deno.mkdirSync(dimseDir, { recursive: true });
    this.storeScp = new Deno.Command("storescp", {
      cwd: dimseDir,
      args: [
        "--sort-on-study-uid",
        "",
        "--exec-on-reception",
        "mv #p/#f #p/#f.complete",
        "--exec-on-eostudy",
        "echo detected eos",
        "--eostudy-timeout",
        "1",
        dimsePort.toString(),
      ],
    }).spawn();
  }

  request(studyId: string, config: DicomProviderConfig): Study {
    let study = this.studies.get(studyId);
    if (!study) {
      study = new Study(studyId, config);
      this.studies.set(studyId, study);
      const quietTime = study.lastRequestTime;
      study.eventEmitter.on("move-failed", () => {
        this.studies.delete(studyId);
      })
 
      study.eventEmitter.on("no-readers-remain", () => {
        try {study?.moveCommand?.kill()} catch {}
        setTimeout(() => {
          if (study!.lastRequestTime > quietTime) {
            return;
          }
          console.log("After no activity, cleaning study dir", study?.downloadDir);
          Deno.removeSync(study!.downloadDir!, { recursive: true });
          this.studies.delete(studyId);
        }, 1000 * 3600);
      });
    } else {
      study.addReader();
    }

    return study;
  }

  finished(studyId: string) {
    const study = this.studies.get(studyId);
    study?.removeReader();
  }
}

const studyDownloadManager = new StudyDownloadManager(dimseDir);

export class DicomProviderDimse extends DicomProvider {
  async evaluateWado(
    wadoPath: string,
    _reqHeaders: Record<string, string>,
  ): Promise<DicomWebResult> {
    const studyUid = wadoPath.split("/")[0];
    const study = studyDownloadManager.request(studyUid, this.config);

    async function* multipartStreamGenerator() {
        const encode = new TextEncoder();
        const files = study.files();
        const boundary = crypto.randomUUID();
        let started = false;
        for await (const f of files) {
          if (started) {
            yield encode.encode("\r\n");
          } else {
            started = true;
          }
          yield encode.encode(`--${boundary}\r\n`);
          yield encode.encode(
            `Content-Type: application/dicom\r\nMIME-Version: 1.0\r\n\r\n`,
          );
          const readable = (await Deno.open(f)).readable;
          for await (const chunk of readable) {
            yield chunk;
          }
        }
        yield encode.encode(`\r\n--${boundary}--\r\n`);
        studyDownloadManager.finished(studyUid);
    }

    const chunkGenerator = multipartStreamGenerator();
    const body = new ReadableStream({
      async pull(controller) {
        const nextChunk = await chunkGenerator.next();
        if (nextChunk.value) {
          controller.enqueue(nextChunk.value);
        }
        if (nextChunk.done) {
          controller.close();
          cleanup();
        }
      },
      cancel(_reason) {
        cleanup();
      },
    }, { highWaterMark: 20 });

    function cleanup() {
      studyDownloadManager.finished(studyUid);
    }

    return {
      headers: {
        "content-type": 'multipart/related; type="application/dicom"',
      },
      body,
    };
  }

  async evaluateQido(query: Record<string, string>): Promise<StudyEnriched[]> {
    const tempDir = await Deno.makeTempDir();
    // reformat to take advantage of parsing, whicn doesn't understnd "dimse"
    const url = new URL(this.config.endpoint.replace("dimse://", "https://"));
    const findResult = await new Deno.Command("findscu", {
      cwd: tempDir,
      args: [
        ...`-aet NAME -S -k QueryRetrieveLevel=SERIES -k SeriesInstanceUID -k Modality -k 0008,0061 -k StudyInstanceUID -k PatientName -k PatientID -k StudyDate -k StudyTime -k ModalitiesInStudy -k StudyDescription --extract`
          .split(/\s+/),
        ...Object.entries(query).flatMap(([k, v]) => [`-k`, `${k}=${v}`]),
        url.hostname,
        url.port,
      ],
    }).spawn().status;

    if (!findResult.success) {
      throw "Could not run find";
    }

    const series = [];
    for await (const seriesFile of Deno.readDir(tempDir)) {
      if (seriesFile.isFile) {
        const json = await new Deno.Command("dcm2json", {
          cwd: tempDir,
          args: [seriesFile.name],
        }).output();
        if (!json.success) {
          continue;
        }
        series.push(
          JSON.parse(
            new TextDecoder().decode(json.stdout),
          ) as QidoResponse[number],
        );
      }
    }

    const studies: Record<string, StudyEnriched> = {}
    for (const s of series) {
      const studyUid = s[TAGS.STUDY_UID].Value[0];
      if (!studies[studyUid]) {
        studies[studyUid] = {studyQido: s, series: []}
      }
      studies[studyUid].series!.push({seriesQido: s})
    }
    for (const s of Object.values(studies)) {
      s.studyQido[TAGS.SERIES_UID].Value = s.series!.flatMap(se => se.seriesQido[TAGS.SERIES_UID].Value);
      s.studyQido[TAGS.MODALITIES_IN_STUDY].Value = [...new Set(s.series!.flatMap(se => se.seriesQido[TAGS.MODALITY].Value))];
    }

    // not awaiting; can happen in background
    Deno.remove(tempDir, { recursive: true });
    return Object.values(studies)
  }
}

DicomProvider.registerType("dicom-dimse", DicomProviderDimse);
