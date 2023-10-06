import { Hono, HTTPException, jose, serveStatic } from "./deps.ts";

import * as path from "https://deno.land/std@0.179.0/path/mod.ts";
import { baseUrl } from "./config.ts";
import { DicomProvider, wadoRouter } from "./dicom_provider.ts";
import { fhirRouter } from "./fhir.ts";
import { Introspection } from "./introspection.ts";
import { HonoEnv } from "./types.ts";
export  { DicomProviderDimse } from "./dicom_provider_dimse.ts";
export { DicomProviderWeb } from "./dicom_provider_web.ts";


// const app = new Application<AppState>();
const tenantConfig = new Map<string, unknown>();
for (const f of Deno.readDirSync("config")) {
  if (f.name.match(/\.json$/)) {
    tenantConfig.set(
      f.name.replace(/\.json$/, ""),
      JSON.parse(Deno.readTextFileSync(path.resolve("config", f.name))),
    );
  }
}

const tenantApp = new Hono<HonoEnv>();
tenantApp
  .use("/:suffix{.*}", async (c, next) => {
    const params = c.req.param() as Record<"suffix" | "tenant" | "dyn", string | undefined>;

    let tenant;
    if (params.dyn) {
      tenant = JSON.parse(new TextDecoder().decode(jose.base64url.decode(params["dyn"])));
    } else if (params.tenant) {
      tenant = tenantConfig.get(params.tenant);
    } else {
      throw new HTTPException(403, { message: "Cannot resolve tenant" });
    }
    const tenantKey = params.dyn ? `dyn/${params.dyn}` : params.tenant!;
    c.set("tenant", {
      key: tenantKey,
      config: tenant,
      baseUrl:  baseUrl + "/" + tenantKey
    });

    const authorizer =  await Introspection.create(tenant.authorization).makeAuthorizer(c);
    c.set("authorizer", authorizer)

    c.set("tenantImageProvider",
      DicomProvider.create(
        tenant.images,
        baseUrl + "/" + (params.dyn ? `dyn/${params.dyn}` : params.tenant),
      ),
    );
    await next();
  })
  .route("/wado", wadoRouter)
  .route("/fhir", fhirRouter);

const ROOT_DIR = "public";
const ROOT_DIR_PATH = "/app/*";

export const app = new Hono();
app
  .get(
    ROOT_DIR_PATH,
    serveStatic({
      root: ROOT_DIR,
      rewriteRequestPath: (path) => path.split("/").slice(2).join("/"),
    }),
  )
  .route("/dyn/:dyn", tenantApp)
  .route("/:tenant", tenantApp)
  .get("/", (c) => c.redirect("https://github.com/jmandel/smart-imaging#getting-started", 302));
