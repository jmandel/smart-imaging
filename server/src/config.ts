import { jose } from "./deps.ts";

const defaultPort = 8000;
export const port = parseInt(
  (Deno.permissions.querySync({ name: "env", variable: "PORT" }).state ===
      "granted" &&
    Deno.env.get("PORT")) ||
    defaultPort.toString(),
);

const defaultBaseUrl = `http://localhost:${port}`;
export const baseUrl =
  Deno.permissions.querySync({ name: "env", variable: "BASE_URL" }).state ===
      "granted"
    ? Deno.env.get("BASE_URL") ?? defaultBaseUrl
    : defaultBaseUrl;

async function hashPhraseToUint8Array(phrase: string) {
  const encoder = new TextEncoder();
  const data = encoder.encode(phrase);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(hashBuffer);
}

const defaultKeyArray = new Uint8Array(32);
crypto.getRandomValues(defaultKeyArray);
const defaultKey = jose.base64url.encode(defaultKeyArray);

export const pathKey = await hashPhraseToUint8Array(
  (Deno.permissions.querySync({ name: "env", variable: "PATH_KEY" }).state ===
      "granted" && Deno.env.get("PATH_KEY")) || defaultKey,
);

const defaultDimseDir = `/tmp/dimse`;
export const dimseDir =
  Deno.permissions.querySync({ name: "env", variable: "DIMSE_DIR" }).state ===
        "granted" &&
    Deno.env.get("DIMSE_DIR") || defaultDimseDir;

const defaultDimsePort = 30104;
export const dimsePort = parseInt(
  Deno.permissions.querySync({ name: "env", variable: "DIMSE_PORT" }).state ===
          "granted" && Deno.env.get("DIMSE_PORT") || defaultDimsePort.toString(),
);
