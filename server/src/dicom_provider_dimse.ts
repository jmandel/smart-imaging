import { jose } from "./deps.ts";
import { DicomProvider, DicomWebResult } from "./dicom_provider.ts";
import { QidoResponse } from "./types.ts";

// TODO: Run a persistent listener to avoid port contention
export class DicomProviderDimse extends DicomProvider {
  async evaluateWado(
    path: string,
    _reqHeaders: Record<string, string>,
  ): Promise<DicomWebResult> {
    const { hostname: endpointHost, port: endpointPort } = new URL(
      this.config.endpoint.replace("dimse://", "https://"),
    );
    const { hostname: aeTitle, port: aePort } = new URL(
      this.config.ae!.replace("dimse://", "https://"),
    );

    const studyUid = path.split("/")[0];
    const tempDir = await Deno.makeTempDir();
    const moveCommand = new Deno.Command("movescu", {
      cwd: tempDir,
      args: [
        "-S",
        "--port",
        aePort,
        "-aet",
        aeTitle,
        "-k",
        `0020,000D=${studyUid}`,
        endpointHost,
        endpointPort,
      ],
    }).spawn();

    const fileWatcher = Deno.watchFs(tempDir);
    async function* readyFiles() {
      const emittedFiles: Record<string, true> = {};
      let lastCreated: string[] = [];
      for await (const f of fileWatcher) {
        if (f.kind === "create") {
          lastCreated.forEach((f) => emittedFiles[f] = true);
          yield lastCreated;
          lastCreated = f.paths.map((fn) => fn.split("/").at(-1)!);
        }
      }
      for await (const f of Deno.readDir(tempDir)) {
        if (!emittedFiles[f.name]) {
          yield [f.name];
        }
      }
    }

    async function* multipartStreamGenerator() {
      const encode = new TextEncoder();
      const files = readyFiles();
      const boundary = crypto.randomUUID();
      let started = false;
      for await (const flist of files) {
        for (const f of flist) {
          if (started) {
            yield encode.encode("\r\n");
          } else {
            started = true;
          }
          yield encode.encode(`--${boundary}\r\n`);
          yield encode.encode(
            `Content-Type: application/dicom\r\nMIME-Version: 1.0\r\n\r\n`,
          );
          const readable = (await Deno.open(tempDir + "/" + f)).readable;
          for await (const chunk of readable) {
            yield chunk;
          }
        }
      }
      yield encode.encode(`\r\n--${boundary}--\r\n`);
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

    async function cleanup() {
      try {
        moveCommand.kill();
      } catch {}
      try {
        fileWatcher.close();
      } catch {}
      try {
        await Deno.remove(tempDir, { recursive: true });
      } catch {}
    }

    moveCommand.status.finally(cleanup);
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
