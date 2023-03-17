<script lang="ts">
  import { onMount, afterUpdate } from "svelte";
  import * as dicomParser from "dicom-parser";
  import Viewer from "./Viewer.svelte";

  import * as cornerstone from "cornerstone-core";
  import * as cornerstoneWADOImageLoader from "cornerstone-wado-image-loader";
  import { get } from "svelte/store";
  import { parseMultipart } from "./multipart";
  import * as _ from "lodash";
  import * as fhirclient from "fhirclient";
  import type Client from "fhirclient/lib/Client";

  const smartClientConfig = {
    iss: "https://imaging.argo.run/v/r4/sim/WzMsIjg3YTMzOWQwLThjYWUtNDE4ZS04OWM3LTg2NTFlNmFhYjNjNiIsIiIsIkFVVE8iLDAsMCwwLCIiLCIiLCIiLCIiLCIiLCIiLCIiLDAsMV0/fhir",
    imagingServer: `https://imaging.argo.run/img/open/fhir`,
    clientId: "test",
    scope: "launch/patient patient/*.cruds",
  };

  let smart: Client;
  try {
    fhirclient.oauth2.ready().then((c) => {
      smart = c;
      window.s = c;
    });
  } catch {}

  async function authorize() {
    await fhirclient.oauth2.authorize(smartClientConfig);
  }

  interface StudyFromFhir {
    modality: string;
    endpoint: string;
  }
  let availableStudies: StudyFromFhir[] = [];
  async function getImagesForPatient() {
    const r = await smart.request(
      smartClientConfig.imagingServer + `/ImagingStudy?patient=${smart.state.tokenResponse.patient}`
    );
    const images = r.entry
      .map((e) => e.resource)
      .map((i) => ({
        modality: i.modality[0].code,
        endpoint: i.contained?.[0]?.address,
      }));
    availableStudies = images;
    console.log(r);
    console.log(images);
  }

  $: {
    if (smart) {
      getImagesForPatient();
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

  let study = []; // Your DICOM binary Uint8Arrays
  let allRetrievedInstances: InstanceDetails[] = [];

  interface Study {
    patient: {
      name: string;
      id: string;
    };
    series: {
      number: string;
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
  $: studyLoaded = {
    patient: {
      name: allRetrievedInstances?.[0]?.patientName,
      id: allRetrievedInstances?.[0]?.patientId,
    },
    series: _.chain(allRetrievedInstances)
      .groupBy((i) => i.seriesNumber)
      .values()
      .map((seriesArray) => ({
        number: seriesArray[0].seriesNumber,
        name: seriesArray[0].seriesDescription,
        instances: seriesArray.map((s) => s.imageId),
      }))
      .value(),
  };

  $: console.log("Study", studyLoaded);

  let seriesList = new Map();
  let selectedSeries = null;
  let selectedInstance = null;
  let selectedInstanceIndex = -1;

  function parseStudyMetadata() {
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

  function createSeriesList() {
    const seriesMap = new Map();
    allRetrievedInstances.forEach((metadata) => {
      if (!seriesMap.has(metadata.seriesNumber)) {
        seriesMap.set(metadata.seriesNumber, []);
      }
      seriesMap.get(metadata.seriesNumber).push(metadata);
    });

    return seriesMap;
  }

  function selectSeries(seriesNumber) {
    selectedSeries = seriesNumber;
    selectedInstance = seriesList.get(seriesNumber)[0].imageId;
    selectedInstanceIndex = 0;
  }

  function selectInstance(index) {
    selectedInstance = seriesList.get(selectedSeries)[index].imageId;
    selectedInstanceIndex = index;
  }

  function navigateInstances(event) {
    if (!selectedSeries) return;

    const instances = seriesList.get(selectedSeries);
    if (event.key === "ArrowLeft" && selectedInstanceIndex > 0) {
      selectInstance(selectedInstanceIndex - 1);
    } else if (event.key === "ArrowRight" && selectedInstanceIndex < instances.length - 1) {
      selectInstance(selectedInstanceIndex + 1);
    }
  }

  async function fetchStudy(url) {
    const studyMultipart = await fetch(url, {
      headers: {
        accept: `multipart/related; type=application/dicom; transfer-syntax=*`,
        authorization: smart.getAuthorizationHeader(),
      },
    });

    const parsed = await parseMultipart(studyMultipart);
    study = parsed.parts.map((p) => p.body);
    console.log("Parsed all multi parts", parsed, study);
    allRetrievedInstances = parseStudyMetadata();
    seriesList = createSeriesList();
  }

  onMount(() => {
    document.addEventListener("keydown", navigateInstances);
    return () => {
      document.removeEventListener("keydown", navigateInstances);
    };
  });

  afterUpdate(() => {
    if (selectedSeries && !seriesList.get(selectedSeries).find((meta) => meta.imageId === selectedInstance)) {
      selectInstance(0);
    }
  });
</script>

<div class="menu-bar">
  {#if smart == null}
    <button on:click={authorize}>Connect</button>
  {:else}
    {#each availableStudies as study}
      <button on:click={() => fetchStudy(study.endpoint)}>Fetch {study.modality}</button>
    {/each}
  {/if}
</div>

<div class="container">
    {#if allRetrievedInstances.length}
  <div class="metadata-selection">
    <h2>Patient</h2>
      <p>Name: {allRetrievedInstances[0].patientName}</p>
      <p>ID: {allRetrievedInstances[0].patientId.slice(0, 10)}...</p>
      <p>Date: {allRetrievedInstances[0].instanceDate.slice(0, 4)}</p>
      <p>Study Description: {allRetrievedInstances[0].studyDescription}</p>
  </div>
    <div class="metadata-selection">
      <h2>Series</h2>
      <div class="series-buttons">
        {#each Array.from(seriesList.keys()).map( (k) => [k, seriesList.get(k)[0].seriesDescription] ) as [seriesNumber, seriesDescription]}
          <button on:click={() => selectSeries(seriesNumber)}>{seriesDescription}</button>
        {/each}
      </div>
    </div>
  {/if}

  <div class="images">
    {#if selectedSeries}
      <h2>Instances</h2>
      <div class="instances">
        {#each seriesList.get(selectedSeries) as instance, index (instance.imageId)}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <button on:click={() => selectInstance(index)}>
            <p>Instance: {instance.instanceNumber}</p>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if selectedInstance}
  <Viewer imageId={selectedInstance} />
{/if}

<style>
  :global(:root) {
    --background-color: #1e1e1e;
    --text-color: #e0e0e0;
    --primary-color: #4e9cce;
    --secondary-color: #3a6f8f;
    --border-color: #3a6f8f;
    --font-family: "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif;
  }

  :global(body) {
    font-family: var(--font-family);
    background-color: var(--background-color);
    color: var(--text-color);
    margin: 0;
  }

  :global(#app) {
    display: flex;
    flex-flow: column;
    height: 100%;
  }

  .menu-bar {
    background-color: #3a6f8f;
  }
  .container {
    margin-left: 1em;
    flex-grow: 10;
    display: flex;
    flex-direction: column;
  }
</style>
