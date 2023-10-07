// deno-lint-ignore-file no-explicit-any
import * as asserts from "https://deno.land/std@0.180.0/testing/asserts.ts";
import * as mock from "https://deno.land/std@0.180.0/testing/mock.ts";
import * as dicomweb from "./dicom_provider.ts";

import { Hono } from "./deps.ts";
import { fhirBundle, qidoMock, testConfig, testPatient } from "./fixtures.ts";
import { Authorizer } from "./introspection.ts";
import { AppContext, HonoEnv } from "./types.ts";
import { DicomProviderWeb } from "./dicom_provider_web.ts";

Deno.test("Dicom Web", async (t) => {
  const d = new DicomProviderWeb(testConfig, "https://us.example.org");

  await t.step("format name", () => {
    const result = dicomweb.formatName("Doe^John");
    asserts.assertEquals(result, "John Doe");
  });

  await t.step("format date", () => {
    let result = dicomweb.formatDate("20230101", "121030.123");
    asserts.assertEquals(result, "2023-01-01T12:10:30.123Z");

    result = dicomweb.formatDate("20230101");
    asserts.assertEquals(result, "2023-01-01");
  });

  await t.step("Dicom Web Binary Passthrough", async () => {
    const fetchStub = mock.stub(
      globalThis,
      "fetch",
      mock.returnsNext([
        Promise.resolve(
          new Response("BODY", {
            headers: {
              "content-type": "A",
              "content-length": "B",
              "ignore-me": "C",
            },
          }),
        ),
      ]),
    );

    const result = await d.evaluateWado("1.2.3", {});
    asserts.assertEquals(result.headers["content-type"], "A");
    asserts.assertEquals(result.headers["content-length"], "B");
    asserts.assertExists(result.headers["cache-control"]);
    asserts.assert(result.headers["ignore-me"] === undefined);

    fetchStub.restore();
  });

  let fetchStubForQido: mock.Stub;
  function stubFetch() {
    fetchStubForQido = mock.stub(
      globalThis,
      "fetch",
      mock.returnsNext([
        Promise.resolve(
          new Response(new TextEncoder().encode(JSON.stringify(qidoMock)), {
            headers: {
              "content-type": "application/json",
            },
          }),
        ),
        Promise.resolve(new Response("[]")),
      ]),
    );
  }

  await t.step("Dicom Web Qido Lookup", async () => {
    stubFetch();
    let result = await d.lookupStudies({
      var: {
        authorizer: new Authorizer("sample-tenant", testPatient, false),
        query: { byPatientId: "123" },
      },
    } as unknown as AppContext);
    fetchStubForQido.restore();

    asserts.assertEquals(result.resourceType, "Bundle");
    asserts.assertEquals(result.entry.length, 1);
    asserts.assertEquals(fetchStubForQido.calls.length, 2);

    let url: URL = fetchStubForQido.calls[0].args[0] as URL;
    asserts.assertEquals(url.host, "your.dicom-web.endpoint");

    let params = Array.from(new URLSearchParams(url.search).entries());
    asserts.assertEquals(params.length, ["includefield", "PatientID"].length);

    stubFetch();
    result = await d.lookupStudies({
      var: {
        authorizer: new Authorizer("sample-tenant", testPatient, false),
        query: { byPatientId: "123" },
      },
    } as any);
    fetchStubForQido.restore();

    asserts.assertEquals(result.resourceType, "Bundle");
    asserts.assertEquals(result.entry.length, 1);
    asserts.assertEquals(fetchStubForQido.calls.length, 2);

    url = fetchStubForQido.calls[0].args[0] as URL;
    asserts.assertEquals(url.host, "your.dicom-web.endpoint");

    params = Array.from(new URLSearchParams(url.search).entries());
    asserts.assertEquals(params.length, 2);
  });

  const goodToken = await dicomweb.createUidBindingToken("1.2.3", {
    tenantKey: "sample-tenant",
    byPatientId: testPatient.id,
  });
  const badToken = "BAD";
  const authorizer = new Authorizer("sample-tenant", testPatient, false);
  const app = new Hono<HonoEnv>();
  app
    .use("*", async (c, next) => {
      c.set("authorizer", authorizer);
      c.set("tenantImageProvider", {
        evaluateWado: async () => await { headers: {}, body: "OK" },
        lookupStudies: async () => await fhirBundle,
        delayed: () => ({ delayed: false }),
      } as unknown as dicomweb.DicomProvider);
      await next();
    })
    .route("/wado", dicomweb.wadoRouter);

  await t.step("Verifies path-based study token", async () => {
    const response = await app.request(`/wado/${badToken}/studies/1.2.3`);
    asserts.assertEquals(response.status, 403);
  });

  await t.step("Does not route WADO requests without a study", async () => {
    const response = await app.request(`/wado/${goodToken}`);
    asserts.assertEquals(response.status, 404);
  });

  await t.step("Responds to WADO requests when valid binding token is present", async () => {
    const response = await app.request(`/wado/${goodToken}/studies/1.2.3`);
    asserts.assertEquals(response.status, 200);
  });

  authorizer.tenantKey = "non-matching";
  await t.step(
    "Fails requests when the bindnig token has tenantKey " + authorizer.tenantKey,
    async () => {
      const response = await app.request(`/wado/${goodToken}/studies/1.2.3`);
      asserts.assertEquals(response.status, 403);
    },
  );
});
