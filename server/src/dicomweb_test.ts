import * as dicomweb from "./dicomweb.ts";
import * as asserts from "https://deno.land/std@0.180.0/testing/asserts.ts";
import * as snapshot from "https://deno.land/std@0.180.0/testing/snapshot.ts";
import * as mock from "https://deno.land/std@0.180.0/testing/mock.ts";
import { oak } from "./deps.ts";

import { Patient } from "./types.ts";

// deno-lint-ignore require-await
Deno.test("Dicom Web", async (t) => {
  const testConfig: dicomweb.DicomProviderConfig = {
    type: "dicom-web",
    lookup: "studies-by-mrn",
    endpoint: "https://your.dicom-web.endpoint",
    authentication: {
      type: "http-basic",
      username: "your-username",
      password: "your-password",
    },
  };

  const testPatient: Patient = {
    id: "123",
    name: [
      {
        text: "A B",
        given: ["A"],
        family: "B",
      },
    ],
    identifier: [
      {
        type: {
          coding: [
            {
              system: "http://terminology.hl7.org/CodeSystem/v2-0203",
              code: "MR",
            },
          ],
        },
        system: "http://example.org",
        value: "123",
      },
    ],
  };
  const qidoMock = [
    {
      "00080005": {
        Value: ["ISO_IR 100"],
        vr: "CS",
      },
      "00080020": {
        vr: "DA",
      },
      "00080030": {
        vr: "TM",
      },
      "00080050": {
        vr: "SH",
      },
      "00080061": {
        Value: ["MR"],
        vr: "CS",
      },
      "00080090": {
        vr: "PN",
      },
      "00081190": {
        Value: [
          "http://imaging-local.argo.run/dicom-web/studies/1.2.276.0.7230010.3.1.2.4094314496.1.1679168756.833040",
        ],
        vr: "UR",
      },
      "00100010": {
        Value: [
          {
            Alphabetic: "Anonymized2",
          },
        ],
        vr: "PN",
      },
      "00100020": {
        Value: ["84f6591c-e2d5-450e-b480-420c9943a6e3"],
        vr: "LO",
      },
      "00100030": {
        vr: "DA",
      },
      "00100040": {
        vr: "CS",
      },
      "0020000D": {
        Value: ["1.2.276.0.7230010.3.1.2.4094314496.1.1679168756.833040"],
        vr: "UI",
      },
      "00200010": {
        vr: "SH",
      },
      "00201206": {
        Value: [14],
        vr: "IS",
      },
      "00201208": {
        Value: [263],
        vr: "IS",
      },
    },
  ];
  const d = new dicomweb.DicomProvider(testConfig, "https://us.example.org");

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
          })
        ),
      ])
    );

    const result = await d.evaluateDicomWeb("1.2.3", new Headers());
    asserts.assertEquals(result.headers["content-type"], "A");
    asserts.assertEquals(result.headers["content-length"], "B");
    asserts.assertExists(result.headers["cache-control"]);
    asserts.assert(result.headers["ignore-me"] === undefined);

    fetchStub.restore();
  });

  await t.step("Dicom Web Qido Lookup", async () => {
    let fetchStub = mock.stub(
      globalThis,
      "fetch",
      mock.returnsNext([
        Promise.resolve(
          new Response(new TextEncoder().encode(JSON.stringify(qidoMock)), {
            headers: {
              "content-type": "application/json",
            },
          })
        ),
      ])
    );

    let result = await d.lookupStudies();
    fetchStub.restore();
    asserts.assertEquals(result.resourceType, "Bundle");
    asserts.assertEquals(result.entry.length, 1);
    asserts.assertEquals(fetchStub.calls.length, 1);

    let url: URL = fetchStub.calls[0].args[0] as URL;
    asserts.assertEquals(url.host, "your.dicom-web.endpoint");

    let params = Array.from(new URLSearchParams(url.search).entries());
    asserts.assertEquals(params.length, 0);

    fetchStub = mock.stub(
      globalThis,
      "fetch",
      mock.returnsNext([
        Promise.resolve(
          new Response(new TextEncoder().encode(JSON.stringify(qidoMock)), {
            headers: {
              "content-type": "application/json",
            },
          })
        ),
      ])
    );

    result = await d.lookupStudies(testPatient);
    fetchStub.restore();

    asserts.assertEquals(result.resourceType, "Bundle");
    asserts.assertEquals(result.entry.length, 1);
    asserts.assertEquals(fetchStub.calls.length, 1);

    url = fetchStub.calls[0].args[0] as URL;
    asserts.assertEquals(url.host, "your.dicom-web.endpoint");

    params = Array.from(new URLSearchParams(url.search).entries());
    asserts.assertEquals(params.length, 1);
  });

  const goodToken = await dicomweb.signStudyUid("1.2.3", testPatient.id);
  const badToken = "BAD";
  const dicomRoutes = dicomweb.wadoRouter.routes();

  const next = oak.testing.createMockNext();
  const makeContext = (path: string) =>
    oak.testing.createMockContext({
      path,
      state: {
        authorizedForPatient: testPatient,
        imagesProvider: { evaluateDicomWeb: () => ({ headers: {}, body: "" }) },
      },
    });

  await t.step("Verifies path-based study token", async () => {
    await asserts.assertRejects(async () => {
      const ctx = makeContext(`/${badToken}/studies/1.2.3`);
      await dicomRoutes(ctx, next);
    });
  });

  await t.step("Does not route WADO requests without a study", async () => {
    const ctx = makeContext(`/${goodToken}`);
    await dicomRoutes(ctx, next);
    const response = await ctx.response;
    asserts.assertEquals(response.status, oak.Status.NotFound);
  });

  await t.step("Responds to WADO requests when binding token is present", async () => {
    const ctx = makeContext(`/${goodToken}/studies/1.2.3`);
    await dicomRoutes(ctx, next);
    const response = await ctx.response;
    asserts.assertEquals(response.status, oak.Status.OK);
  });

});
