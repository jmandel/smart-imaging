const defaultPort = 8000;
export const port = parseInt(
  (Deno.permissions.querySync({ name: "env", variable: "PORT" }).state === "granted" &&
    Deno.env.get("PORT")) ||
    defaultPort.toString(),
);

const defaultBaseUrl = `http://localhost:${port}`;
export const baseUrl =
  Deno.permissions.querySync({ name: "env", variable: "BASE_URL" }).state === "granted"
    ? Deno.env.get("BASE_URL") ?? defaultBaseUrl
    : defaultBaseUrl;
