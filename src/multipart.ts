export async function parseMultipart(response: Response) {
  const contentType = response.headers.get("Content-Type");
  const boundary = contentType!.match(/boundary="?([^";]+)"?/)![1];
  const crlfBoundaryBytes = new TextEncoder().encode(`\r\n--${boundary}`);
  const noCrlfBoundaryBytes = new TextEncoder().encode(`--${boundary}`);

  const data = new Uint8Array(await response.arrayBuffer());
  let state = "preamble";
  let headerStart = -1;
  let headerEnd = -1;

  const parts: { headers: Headers; body: Uint8Array }[] = [];

  function processPart(end: number) {
    const headerBytes = data.subarray(headerStart, headerEnd);
    const headerText = new TextDecoder().decode(headerBytes).trim();
    const headers = new Headers();

    for (const line of headerText.split(/\r\n/)) {
      if (!line.match(":")) {
        continue;
      }
      const [name, value] = line.split(": ");
      headers.append(name.toLowerCase(), value);
    }

    const body = data.subarray(headerEnd + 4, end + 1);
    parts.push({ headers, body });
  }

  let matchCount = 0;
  let boundaryBytes = noCrlfBoundaryBytes;

  for (let i = 0; i < data.length; i++) {
    if (data[i] === boundaryBytes[matchCount]) {
      matchCount++;
    } else {
      matchCount = 0;
    }

    if (state === "header") {
      if (data.subarray(i - 3, i + 1).every((v, j) => v === "\r\n\r\n".charCodeAt(j))) {
        state = "body";
        headerEnd = i - 3;
      }
    }

    if (matchCount === boundaryBytes.length) {
      if (state === "preamble") {
        state = "header";
        headerStart = i + 1;
        boundaryBytes = crlfBoundaryBytes;
      } else if (state === "body") {
        processPart(i - boundaryBytes.length);
        state = "header";
        headerStart = i + 1;
      }

      matchCount = 0;
    }
  }

  return {
    headers: response.headers,
    parts,
  };
}

/*
import { assertEquals } from "https://deno.land/std@0.179.0/testing/asserts.ts";

// Helper function to create a Response object
function createResponse(body: Uint8Array | string, contentType: string) {
  const headers = new Headers();
  headers.set("Content-Type", contentType);
  return new Response(body, { headers });
}

Deno.test("parseMultipart: simple case", async () => {
  const response = createResponse(
    "--simple-boundary\r\n" +
      "\r\n" +
      "This is implicitly typed plain text.\r\n" +
      "--simple-boundary\r\n" +
      "Content-Type: text/plain; charset=us-ascii\r\n" +
      "\r\n" +
      "This is explicitly typed plain text.\r\n" +
      "--simple-boundary--",
    'multipart/mixed; boundary="simple-boundary"',
  );

  const result = await parseMultipart(response);
  assertEquals(result.headers, response.headers);
  assertEquals(result.parts.length, 2);
  assertEquals(result.parts[0].headers.get("Content-Type"), null);
  assertEquals(result.parts[1].headers.get("Content-Type"), "text/plain; charset=us-ascii");
  assertEquals(
    new TextDecoder().decode(result.parts[0].body),
    "This is implicitly typed plain text.",
  );
  assertEquals(
    new TextDecoder().decode(result.parts[1].body),
    "This is explicitly typed plain text.",
  );
});

Deno.test("Parse large file", async () => {
  let boundary = "f1c44f8e-7f89-4d28-9dd8-1dda5b302a39-63cfc7e4-748c-4f9d-b55c-584c79dfa";

  let b = Deno.readFileSync("./ex.bin");
  let r = new Response(b, {
    headers: new Headers({ "Content-Type": `multipart/mixed; boundary="${boundary}"` }),
  });
  const t0 = new Date().getTime();
  let result = await parseMultipart(r);
  const t1 = new Date().getTime();
  assertEquals(result.parts.length, 3);
});
*/
