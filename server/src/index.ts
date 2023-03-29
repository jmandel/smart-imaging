import { Application, jose, Router } from "./deps.ts";

import { AppState } from "./types.ts";

const app = new Application<AppState>();

import { resolve } from "https://deno.land/std@0.179.0/path/mod.ts";
import { Introspection } from "./introspection.ts";
import { DicomProvider, wadoRouter } from "./dicomweb.ts";
import { baseUrl, port, routerOpts } from "./config.ts";
import { fhirRouter } from "./fhir.ts";

const tenantConfig = new Map<string, unknown>();
for (const f of Deno.readDirSync("config")) {
  if (f.name.match(/\.json$/)) {
    tenantConfig.set(
      f.name.replace(/\.json$/, ""),
      JSON.parse(Deno.readTextFileSync(resolve("config", f.name))),
    );
  }
}

const PATHS_WITHOUT_AUTHORIZATION = ["", "metadata"];
const multiTenantRouter = new Router<AppState>(routerOpts);
multiTenantRouter.all("/:dyn(dyn)?/:tenant/(fhir|wado)/:suffix(.*)", async (ctx, next) => {
  if (PATHS_WITHOUT_AUTHORIZATION.includes(ctx.params.suffix)) {
    return await next();
  }

  const tenantKey = ctx.params.tenant;
  let tenant;
  if (ctx.params.dyn) {
    tenant = JSON.parse(new TextDecoder().decode(jose.base64url.decode(tenantKey)));
  } else {
    tenant = tenantConfig.get(tenantKey);
    console.log("In scope", tenant)
  }
  const authzForTenant = Introspection.create(tenant.authorization);
  const { patient, ehrBaseUrl, introspected, disableAccessControl } = await authzForTenant.assignAuthorization(
    ctx,
  );

  console.log("Set up config to", patient, introspected, disableAccessControl, ehrBaseUrl);
  ctx.state.ehrBaseUrl = ehrBaseUrl;
  ctx.state.disableAccessControl = Boolean(disableAccessControl);
  ctx.state.authorizedForPatient = patient;
  ctx.state.introspected = introspected;

  const reqBase = baseUrl;
  ctx.state.imagesProvider = new DicomProvider(
    tenant.images,
    reqBase + (ctx.params.dyn ? `/dyn/${ctx.params.dyn}` : ``) + `/${ctx.params.tenant}`,
  );
  await next();
});

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    console.log("Err", e);
    ctx.response.status = 500;
    ctx.response.body = e.toString();
  }
});

app.use(
  new Router(routerOpts)
    .get("/", (ctx) => {
      ctx.response.redirect("https://github.com/jmandel/smart-imaging#getting-started");
    })
    .routes(),
);

multiTenantRouter.use("/:dyn(dyn)?/:tenant/fhir", fhirRouter.routes());
multiTenantRouter.use("/:dyn(dyn)?/:tenant/wado", wadoRouter.routes());
app.use(multiTenantRouter.routes());

console.log("START", port);
await app.listen({ port });
