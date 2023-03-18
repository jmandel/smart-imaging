<script lang="ts">
  import { onMount, afterUpdate } from "svelte";
  import * as dicomParser from "dicom-parser";
  import Viewer from "./Viewer.svelte";

  import * as cornerstone from "cornerstone-core";
  import * as cornerstoneWADOImageLoader from "cornerstone-wado-image-loader";
  import { parseMultipart } from "./multipart";
  import * as _ from "lodash";

  import { create as createClient, type Client, type ClientConfig } from "./lib/smart";

  let clientConfig: ClientConfig = {
    clientId: "imaging-app",
    iss: "https://imaging.argo.run/v/r4/sim/WzIsIjg3YTMzOWQwLThjYWUtNDE4ZS04OWM3LTg2NTFlNmFhYjNjNiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMV0/fhir",
    scope: "launch/patient patient/*.rs",
    imagingServer: "https://imaging.argo.run/img/open/fhir",
  };
  const { client, authorize } = createClient(clientConfig);

  let imagingStudies = [];
  async function fetchPatient(client: Client) {
    const patient = await client.patient.read();
    console.log("Patient", patient);

    const images = await client.images();
    imagingStudies = images.entry
      .map((e) => e.resource)
      .map((r) => ({
        address: r.contained[0].address,
        modality: r.modality[0].code,
      }));
    console.log("Images", images, imagingStudies);
  }

  $: {
    if ($client) {
      fetchPatient($client);
    }
  }

  cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
  cornerstoneWADOImageLoader.external.cornerstone = cornerstone;

  // workaround https://github.com/cornerstonejs/cornerstoneWADOImageLoader/issues/403#issuecomment-984543027
  const config = {
    maxWebWorkers: navigator.hardwareConcurrency || 1,
    startWebWorkersOnDemand: true,
    webWorkerTaskPaths: [
      new URL("610.bundle.min.worker.js", window.location.href + "/").href,
      new URL("888.bundle.min.worker.js", window.location.href + "/").href,
    ],
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
      },
    },
  };
  cornerstoneWADOImageLoader.webWorkerManager.initialize(config);

  let allRetrievedInstances: InstanceDetails[] = [];

  interface Study {
    date: string;
    description;
    patient: {
      name: string;
      id: string;
    };
    series: {
      number: number;
      name: string;
      instances: string[];
    }[];
  }

  interface InstanceDetails {
    imageId: string;
    patientName: string;
    patientId: string;
    instanceDate: string;
    studyDescription: string;
    seriesNumber: number;
    seriesDescription: string;
    instanceNumber: number;
  }

  let studyLoaded: Study | null;
  $: allRetrievedInstances.length && (studyLoaded = {
      date: allRetrievedInstances?.[0]?.instanceDate,
      description: allRetrievedInstances?.[0]?.studyDescription,
      patient: {
        name: allRetrievedInstances?.[0]?.patientName,
        id: allRetrievedInstances?.[0]?.patientId,
      },
      series: _.chain(allRetrievedInstances)
        .groupBy((i) => i.seriesNumber)
        .values()
        .map((seriesArray, i) => ({
          number: i,
          name: seriesArray[0].seriesDescription,
          instances: seriesArray.map((s) => s.imageId),
        }))
        .value(),
    });

  $: console.log("Study", studyLoaded);

  let selectedSeries = null;
  let selectedInstance = null;

  function parseStudyMetadata(study: Uint8Array[]) {
    cornerstoneWADOImageLoader.wadouri.fileManager.purge();
    const instances: InstanceDetails[] = study.map((dicomData) => {
      const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(new Blob([dicomData]));
      const dataSet = dicomParser.parseDicom(dicomData);
      return {
        imageId,
        patientName: dataSet.string("x00100010"),
        patientId: dataSet.string("x00100020"),
        instanceDate: dataSet.string("x00080012"),
        studyDescription: dataSet.string("x00081030"),
        seriesNumber: dataSet.intString("x00200011"),
        seriesDescription: dataSet.string("x0008103e"),
        instanceNumber: dataSet.intString("x00200013"),
      };
    });
    return instances;
  }

  function selectSeries(seriesNumber) {
    selectedSeries = seriesNumber;
    selectedInstance = studyLoaded.series[seriesNumber].instances[0];
  }

  async function fetchStudy(url: string) {
    const studyMultipart = await fetch(url, {
      headers: {
        accept: `multipart/related; type=application/dicom; transfer-syntax=*`,
        authorization: $client.getAuthorizationHeader(),
      },
    });

    const parsed = await parseMultipart(studyMultipart);
    const study = parsed.parts.map((p) => p.body);
    console.log("Parsed all multi parts", parsed, study);
    allRetrievedInstances = parseStudyMetadata(study);
  }

  // fetchStudy(
  //   "https://imaging.argo.run/orthanc/dicom-web/studies/1.2.276.0.7230010.3.1.2.4094306560.1.1678736912.732222"
  // );
</script>

<div class="menu-bar container">
  <h1 class="logo">
    SMART
    <span class="material-icons">image</span>
    Demo
  </h1>
  <nav class="nav-links">
    <div style="display: flex; gap: .5rem;">Settings<span class="material-icons">settings</span></div>
  </nav>
</div>

<div class="container">
  {#if $client === null}
    <div class="row">
      <div class="col col-2">
        <button on:click={() => authorize()}>Connect</button>
      </div>
    </div>
  {:else if !studyLoaded}
    {#each imagingStudies as study}
      <button value={study.address} on:click={() => fetchStudy(study.address)}>Fetch {study.modality}</button>
    {/each}
  {:else}
    <div class="row">
      <div class="col col-2">
        <h2>Patient</h2>
        {#if studyLoaded}
          <p>Name: {studyLoaded.patient.name}</p>
          <p>ID: {studyLoaded.patient.id}</p>
          <p>Date: {studyLoaded.date}</p>
          <p>Study Description: {studyLoaded.description}</p>
        {:else}
          <p>Loading...</p>
        {/if}
      </div>
      <div class="col col-2">
        <h2>Select Series</h2>
        <div class="series-buttons">
          {#each studyLoaded.series as series, i}
            <button on:click={() => selectSeries(i)}>{series.name}</button>
          {/each}
        </div>
      </div>
    </div>
  {/if}

  {#if selectedInstance}
    <div class="row">
      <div class="col col-4">
        <Viewer imageId={selectedInstance} />
      </div>
    </div>
  {/if}
</div>

<style>
</style>
