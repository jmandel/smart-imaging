<script lang="ts">
  import { onMount, afterUpdate } from "svelte";
  import * as dicomParser from "dicom-parser";
  import Viewer from "./Viewer.svelte";

  import * as cornerstone from "cornerstone-core";
  import * as cornerstoneWADOImageLoader from "cornerstone-wado-image-loader";
  import { parseMultipart } from "./multipart";
  import * as _ from "lodash";

  import { authorize, client, type Client } from "./lib/smart";
  import { forEach } from "lodash";

  let clinicalDetails: {
    name: string;
    birthDate: string;
    activeCounts: {
      AllergyIntolerance: number;
      Condition: number;
      MedicationRequest: number;
    };
  } = null;

  let imagingStudies: StudyToFetch[] = [];
  async function fetchPatient(client: Client) {
    try {
      const patient = await client.patient.read();
      clinicalDetails = {
        name: patient.name[0].text || `${patient.name[0].given.join(" ")} ${patient.name[0].family}`,
        birthDate: patient.birthDate,
      };
      console.log("Patient", patient);

      const statuses = [
        "AllergyIntolerance?clinical-status=active",
        "Condition?clinical-status=active",
        "MedicationRequest?status=active",
      ];

      (async function () {
        const activeCounts: any = Object.fromEntries(
          (await Promise.all(statuses.map((s) => s.split(".")[0]).map((r) => client.patient.request(r)))).map(
            (rb, i) => {
              const resources = (rb as any)?.entry?.map((e) => e.resource) || [];
              console.log(resources);
              return [statuses[i].split("?")[0], resources.length];
            }
          )
        );
        clinicalDetails.activeCounts = activeCounts;
        console.log(clinicalDetails);
      })();
    } catch (e) {
      console.log(e);
      console.log("Could not fetch patient; destroying client");
      $client = null;
    }

    const images = await client.images();
    imagingStudies = images.entry
      .map((e) => e.resource)
      .map((r) => ({
        uid: r.identifier[0].value.slice(8),
        address: r.contained[0].address,
        modality: r.modality[0].code,
      }));
    console.log("Images", images, imagingStudies);
  }

  function nextInstance(change?: number, exact?: number) {
    const instances = studyLoaded.series[selectedSeries].instances;
    const currentInstanceIndex = instances.indexOf(selectedInstance);
    const target = exact ?? currentInstanceIndex + change;
    if (target >= 0 && target < instances.length) {
      selectedInstance = instances[target];
      instanceRangeSlider = target;
    }
  }

  onMount(() => {
    // Add event listener to window
    function listen(e: KeyboardEvent) {
      if (e.key === ">") {
        nextInstance(1);
      }
      if (e.key === "<") {
        nextInstance(-1);
      }
    }

    window.addEventListener("keydown", listen);
    return () => window.removeEventListener("keydown", listen);
  });

  $: {
    if ($client) {
      fetchPatient($client);
      window.c = $client;
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
  $: allRetrievedInstances.length &&
    (studyLoaded = {
      date: allRetrievedInstances?.[0]?.instanceDate,
      description: allRetrievedInstances?.[0]?.studyDescription,
      patient: {
        name: allRetrievedInstances?.[0]?.patientName,
        id: allRetrievedInstances?.[0]?.patientId,
      },
      series: _.chain(allRetrievedInstances)
        .sortBy((i) => i.seriesNumber)
        .groupBy((i) => i.seriesNumber)
        .values()
        .map((seriesArray, i) => ({
          number: i,
          name: seriesArray[0].seriesDescription,
          instances: _.chain(seriesArray)
            .sortBy((s) => s.instanceNumber)
            .map((s) => s.imageId)
            .value(),
        }))
        .value(),
    });

  $: console.log("Study", studyLoaded);

  let selectedSeries: number | null = null;
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

  let instanceRangeSlider = 0;
  let instanceRange = [0, 0];

  function selectSeries(seriesNumber) {
    selectedSeries = seriesNumber;
    selectedInstance = studyLoaded.series[seriesNumber].instances[0];
    instanceRange = [0, studyLoaded.series[seriesNumber].instances.length - 1];
    instanceRangeSlider = 0;
  }

  interface StudyToFetch {
    address: string;
    uid: string;
    modality: string;
  }
  let studyDownloading = false;
  async function fetchStudy({ address, uid }: StudyToFetch) {
    studyDownloading = true;
    const studyMultipart = await fetch(`${address}/studies/${uid}`, {
      headers: {
        accept: `multipart/related; type=application/dicom; transfer-syntax=*`,
        authorization: $client.getAuthorizationHeader(),
      },
    });
    const parsed = await parseMultipart(studyMultipart);
    const study = parsed.parts.map((p) => p.body);
    console.log("Parsed all multi parts", parsed, study);
    allRetrievedInstances = parseStudyMetadata(study);
    studyDownloading = false;
  }

  // fetchStudy(
  //   "https://imaging.argo.run/orthanc/dicom-web/studies/1.2.276.0.7230010.3.1.2.4094306560.1.1678736912.732222"
  // );
</script>

<div class="menu-bar container">
  <h1 class="logo" style="display: flex; align-items: center;">
    SMART
    <span class="material-icons">image</span>
    Demo
  </h1>
  <nav class="nav-links">
    <div style="display: flex; gap: .5rem; align-items: center">
      Settings<span class="material-icons">settings</span>
    </div>
  </nav>
</div>
<div class="container">
  <div class="row">
    <div class="col col-1 flexv">
      <div class="content-box">
        {#if $client === null}
          <button on:click={() => authorize()}>Connect</button>
        {:else if clinicalDetails}
          <h2>EHR Data</h2>
          <p>{clinicalDetails.name}</p>
          <p>{clinicalDetails.birthDate}</p>
          {#each Object.keys(clinicalDetails.activeCounts || {}) as r}
            <p>{clinicalDetails.activeCounts[r] || "No "} active {r.split(".")[0]}s</p>
          {/each}
        {/if}
        {#if $client && !studyLoaded}
          {#each imagingStudies as study}
            <button disabled={studyDownloading} value={study.address} on:click={() => fetchStudy(study)}
              >Fetch {study.modality}</button
            >
          {/each}
        {/if}
      </div>
      {#if studyLoaded}
        <div class="content-box">
          <h2>
            Study Data (<a
              on:click={() => {
                studyLoaded = null;
              }}
              style="text-decoration: none"
              href="#">↑</a
            >)
          </h2>
          {#if studyLoaded}
            <p>Patient: {studyLoaded.patient.name}</p>
            <p>Study Date: {studyLoaded.date}</p>
            <p>Study Description: {studyLoaded.description}</p>
          {/if}

          <div class="series-buttons">
            {#each studyLoaded.series as series, i}
              <button on:click={() => selectSeries(i)}>{series.name}</button>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <div class="col col-3 content-box">
      {#if selectedInstance}
        {#if instanceRange[1] > 0}
          <input
            class="instance-slider"
            type="range"
            bind:value={instanceRangeSlider}
            min={instanceRange[0]}
            max={instanceRange[1]}
            on:input={(v) => nextInstance(null, parseInt(v.target.value))}
          />
        {/if}
        <Viewer seriesIndex={selectedSeries} imageId={selectedInstance} />
      {/if}
    </div>
  </div>
  <div class="row">
    <footer class="content-box col col-4">
      SMART Imaging Access. Related:
      <a target="_blank" href="https://chat.fhir.org/#narrow/stream/179170-smart">chat</a>,
      <a target="_blank" href="https://github.com/jmandel/smart-imaging">source</a>.
    </footer>
  </div>
</div>

<style>
  .instance-slider {
    width: 100%;
  }
  button.tiny {
    width: 0.3em;
    height: 0.5em;
    font-size: 0.2em;
  }

  .flexv {
    display: flex;
    flex-wrap: wrap;
    row-gap: 1em;
  }

  .series-buttons {
    display: flex;
    flex-wrap: wrap;
  }

  .series-buttons button {
    width: 100%;
  }
</style>
