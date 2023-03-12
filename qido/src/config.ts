const defaultPort = 8000;
export const port = parseInt(
  (Deno.permissions.querySync({ name: "env", variable: "PORT" }).state ===
      "granted" &&
    Deno.env.get("PORT")) ||
    defaultPort.toString(),
);

export const baseUrl = `http://localhost:${port}`;

