import { jose } from "./deps.ts";
import {
  DicomProvider,
  DicomProviderConfig,
  DicomWebResult,
} from "./dicom_provider.ts";
import { QidoResponse } from "./types.ts";
import { path } from "./deps.ts";
import { dimseDir, dimsePort } from "./config.ts";

import { EventEmitter } from "node:events";

class Study {
  public readersCount: number;
  public eventEmitter: EventEmitter;
  private allFilesDownloaded = false;
  public downloadDir: string;
  private fileWatcher: Deno.FsWatcher | undefined;
  initialized: Promise<true>;

  constructor(public studyUid: string, public config: DicomProviderConfig) {
    this.studyUid = studyUid;
    this.readersCount = 1;
    this.eventEmitter = new EventEmitter();
    this.downloadDir = path.join(dimseDir, studyUid);
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

    moveCommand.status.then(async s => {
      console.log("Move commnd returnd", s)
      if (s.success) {
        await Deno.writeTextFile(path.join(this.downloadDir, ".study-complete"), "");
        console.log("Wrote study complete")
      } else {
        console.log("Move comman failed", s)
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
          resolve(result);
        };
        this.eventEmitter.once("file-ready", resolveHandler);
        this.eventEmitter.once("study-ready", resolveHandler);
      });

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

  download(studyId: string, config: DicomProviderConfig): Study {
    let study = this.studies.get(studyId);
    if (!study) {
      study = new Study(studyId, config);
      this.studies.set(studyId, study);
      study.eventEmitter.on("no-readers-remain", () => {
        setTimeout(() => {
          if (study!.readersCount > 0) {
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
    const study = studyDownloadManager.download(studyUid, this.config);

    async function* multipartStreamGenerator() {
      try {
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
      } catch (e) {
        console.log("Err generating chunk", e);
      }
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

  async evaluateQido(query: Record<string, string>): Promise<QidoResponse> {
    const tempDir = await Deno.makeTempDir();
    // reformat to take advantage of parsing, whicn doesn't understnd "dimse"
    const url = new URL(this.config.endpoint.replace("dimse://", "https://"));
    const findResult = await new Deno.Command("findscu", {
      cwd: tempDir,
      args: [
        ..."-aet NAME -S -k QueryRetrieveLevel=STUDY -k StudyInstanceUID -k PatientName -k PatientID -k StudyDate -k StudyTime -k ModalitiesInStudy -k StudyDescription --extract"
          .split(/\s+/),
        ...Object.entries(query).flatMap(([k, v]) => [`-k`, `${k}=${v}`]),
        url.hostname,
        url.port,
      ],
    }).spawn().status;

    if (!findResult.success) {
      throw "Could not run find";
    }

    const studies = [];
    for await (const studyFile of Deno.readDir(tempDir)) {
      if (studyFile.isFile) {
        const json = await new Deno.Command("dcm2json", {
          cwd: tempDir,
          args: [studyFile.name],
        }).output();
        if (!json.success) {
          continue;
        }
        studies.push(
          JSON.parse(
            new TextDecoder().decode(json.stdout),
          ) as QidoResponse[number],
        );
      }
    }

    // not awaiting; can happen in background
    Deno.remove(tempDir, { recursive: true });
    return studies;
  }
}

DicomProvider.registerType("dicom-dimse", DicomProviderDimse);
