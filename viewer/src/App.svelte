<script lang="ts">
  import svelteLogo from "./assets/svelte.svg";
  import viteLogo from "/vite.svg";
  import Counter from "./lib/Counter.svelte";

  import { parseMultipart } from "./multipart";

  import { onMount, afterUpdate } from "svelte";
  import * as dicomParser from "dicom-parser";
  import Thumbnail from "./Thumbnail.svelte";
  import Viewer from "./Viewer.svelte";

  import * as cornerstone from "cornerstone-core";
  import * as cornerstoneWADOImageLoader from "cornerstone-wado-image-loader";
  import { get } from "svelte/store";

  cornerstoneWADOImageLoader.external.dicomParser = dicomParser
  cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
  // cornerstone.registerImageLoader("urn", loadDicomImage);

  let study = []; // Your DICOM binary Uint8Arrays
  let studyMetadata = [];
  let seriesList = new Map();
  let selectedSeries = null;
  let selectedInstance = null;
  let selectedInstanceIndex = -1;

  function parseStudyMetadata() {
    cornerstoneWADOImageLoader.wadouri.fileManager.purge();

    return study.map((dicomData) => {
      const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(new Blob([dicomData]));
      const dataSet = dicomParser.parseDicom(dicomData);

      return {
        imageId,
        patientName: dataSet.string("x00100010"),
        patientId: dataSet.string("x00100020"),
        instanceDate: dataSet.string("x00080012"),
        studyDescription: dataSet.string("x00081030"),
        seriesNumber: dataSet.intString("x00200011"),
        seriesDescription: dataSet.string('x0008103e'),
        instanceNumber: dataSet.intString("x00200013"),
      };
    });
  }

  function createSeriesList() {
    const seriesMap = new Map();
    studyMetadata.forEach((metadata) => {
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

  async function fetchStudy() {
    const studyMultipart = await fetch(
      "https://imaging-local.argo.run/orthanc/dicom-web/studies/1.2.276.0.7230010.3.1.2.4094306560.1.1678736912.732222",
      {
        headers: {
          accept: `*/*`,
          authorization: `Basic ${btoa(`argonaut:argonaut`)}`,
        },
      }
    );

    const parsed = await parseMultipart(studyMultipart);
    study = parsed.parts.map((p) => p.body);
    console.log("PArsed", parsed, study);
    studyMetadata = parseStudyMetadata();
    seriesList = createSeriesList();
  }

  onMount(() => {
    document.addEventListener("keydown", navigateInstances);
    fetchStudy();

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
  <div class="menu-item">File</div>
  <div class="menu-item">Edit</div>
  <div class="menu-item">View</div>
  <div class="menu-item">Help</div>
</div>

<div class="container">
  <div class="metadata-selection">
    <h2>Patient</h2>
    {#if studyMetadata.length}
      <p>Name: {studyMetadata[0].patientName}</p>
      <p>ID: {studyMetadata[0].patientId.slice(0, 10)}...</p>
      <p>Date: {studyMetadata[0].instanceDate.slice(0,4)}</p>
      <p>Study Description: {studyMetadata[0].studyDescription}</p>
    {:else}
      <p>Loading...</p>
    {/if}
  </div>

  <div class="metadata-selection">
    <h2>Select Series</h2>
    <div class="series-buttons">
      {#each Array.from(seriesList.keys()).map(k => [k, seriesList.get(k)[0].seriesDescription]) as [seriesNumber, seriesDescription]}
        <button on:click={() => selectSeries(seriesNumber)}>{seriesDescription}</button>
      {/each}
    </div>
  </div>

  <div class="images">
    {#if selectedSeries}
      <h2>Instances</h2>
      <div class="instances">
        {#each seriesList.get(selectedSeries) as instance, index (instance.imageId)}
          <div
            style="border: {selectedInstance === instance.imageId ? '2px solid blue' : '2px solid transparent'};"
            on:click={() => selectInstance(index)}
          >
            <Thumbnail imageId={instance.imageId} />
            <p>Instance: {instance.instanceNumber}</p>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

{#if selectedInstance}
  <Viewer imageId={selectedInstance} />
{/if}

<style>
  :root {
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
    flex-wrap: wrap;
    display: flex;
    width: 100%;
    height: 100%;
    place-self: flex-start;
  }

  h2 {
    font-weight: bold;
    margin-bottom: 0.5rem;
  }

  p {
    margin-top: 0;
    margin-bottom: 0.5rem;
  }

  button {
    background-color: var(--primary-color);
    border: none;
    color: var(--text-color);
    padding: 10px 20px;
    text-align: center;
    text-decoration: none;
    display: inline-block;
    font-size: 14px;
    margin: 2px 2px;
    cursor: pointer;
    border-radius: 4px;
    font-family: var(--font-family);
    transition: background-color 0.3s;
  }

  button:hover {
    background-color: var(--secondary-color);
  }

  .container {
    display: flex;
  }

  .metadata-selection {
    flex: 1;
    align-items: first baseline;
  }

  .images {
    flex: 1;
  }

  .series-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-bottom: 20px;
  }

  .instances {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 10px;
  }

  .menu-bar {
    display: flex;
    align-items: center;
    background-color: var(--secondary-color);
    padding: 0.5rem 1rem;
    flex: 0 0 100%;
  }

  .menu-item {
    margin-left: 1rem;
    cursor: pointer;
  }

  .menu-item:first-child {
    margin-left: 0;
  }

  .viewer-controls {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
</style>
