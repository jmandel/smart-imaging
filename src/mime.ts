import { readableStreamFromIterable } from "https://deno.land/std@0.179.0/streams/readable_stream_from_iterable.ts";
import { Router } from "./deps.ts";

export const mimeRouter = new Router()
.get("/mime", (ctx) => {
  const boundary = crypto.randomUUID()
  ctx.response.headers.set("content-type", `Content-Type: multipart/related; type="application/dicom"; boundary=${boundary}`)
  ctx.response.body = rs(boundary);
});
// app.use(mimeRouter.routes());



function anonymize(id: string) {
  return fetch(`http://localhost:8042/instances/${id}/anonymize`, {
    method: "POST",
    headers: { authorization: `Basic ${btoa(`orthanc:orthanc`)}` },
    body: JSON.stringify({
      Replace: {
        PatientName: "New Patient anonymized for " + id,
        "0010-1001": "World",
      },
      Keep: ["StudyDescription", "SeriesDescription"],
      KeepPrivateTags: false,
    }),
  });
}

const generateParts = (ids: string[], boundary: string) => {
  const boundaryLine = "\n--" + boundary;
  return async function* () {
    for (const id of ids) {
      const result = await anonymize(id);
      console.log("RES", result)
      const headers = [
        `Content-Type: ${result.headers.get("content-type")}`,
        `Content-Length: ${result.headers.get("content-length")}`,
        `MIME-Version: 1.0`,
      ];
      yield boundaryLine + "\n" + headers.join("\n") + "\n\n";
      //   const result = await new Promise((resolve) => setTimeout(() => resolve("Got " + id), 100));
      const ab = await result.arrayBuffer()
      console.log("AB", ab.byteLength)
      yield new Uint8Array(ab);
    }
    yield boundary + "--";
    return;
  };
};

export const rs = (boundary: string): ReadableStream => {
  const it = generateParts(["97538ce6-3ba6a483-680c91d1-500fca24-67790335"], boundary);
  return readableStreamFromIterable(it());
};
