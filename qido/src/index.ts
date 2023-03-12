import { Application, jose, Router } from "./deps.ts";

import { AppState } from "./types.ts";

const app = new Application<AppState>();


import { resolve } from "https://deno.land/std@0.179.0/path/mod.ts";
import { Introspection } from "./introspection.ts";
import { wadoRouter } from "./dicomweb.ts";
import { port } from "./config.ts";
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

const multiTenantRouter = new Router<AppState>();
multiTenantRouter.all(
  "/:dyn(dyn)?/:tenant/(fhir|wado)/(.*)",
  async (ctx, next) => {
    console.log("multitenant", ctx.params, ctx.request.url.pathname);
    const tenantKey = ctx.params.tenant;
    let tenant;
    if (ctx.params.dyn) {
      tenant = JSON.parse(
        new TextDecoder().decode(jose.base64url.decode(tenantKey)),
      );
    } else {
      tenant = tenantConfig.get(tenantKey);
    }
    console.log("Tenant", tenant);
    const authzForTenant = Introspection.create(tenant.authorization);
    await authzForTenant.assignAuthorization(ctx);
    console.log("Authzd", ctx.state);
    await next();
  },
);

app.use(async (ctx, next) => {
  try {
    await next();
  } catch (e) {
    console.log("Err", e);
    ctx.response.status = 500;
    ctx.response.body = e.toString();
  }
});


multiTenantRouter.use("/:dyn(dyn)?/:tenant/fhir", fhirRouter.routes());
multiTenantRouter.use("/:dyn(dyn)?/:tenant/wado", wadoRouter.routes());
app.use(multiTenantRouter.routes());

console.log("START", port);
await app.listen({ port });
