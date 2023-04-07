<script lang="ts">
  import { onMount, afterUpdate } from "svelte";
  import * as dicomParser from "dicom-parser";
  import Viewer from "./Viewer.svelte";

  import * as cornerstone from "cornerstone-core";
  import * as cornerstoneWADOImageLoader from "cornerstone-wado-image-loader";
  import { parseMultipart } from "./multipart";
  import * as _ from "lodash";

  import { authorize, client, type Client } from "./lib/smart";
  import Settings from "./Settings.svelte";
  import { settings } from "./settings";

  function beginAuthorization() {
    authorize($settings?.clientConfig[selectedServerIndex]);
  }
  let selectedServerIndex = 0;
  let iss = new URLSearchParams(window.location.search).get("iss");
  if (iss) {
    selectedServerIndex = $settings.clientConfig.findIndex(
      (s) => new URL(s.clinicalServer).origin === new URL(iss).origin
    );
    beginAuthorization();
  }

  let clinicalDetails: {
    name: string;
    birthDate: string;
    activeCounts?: {
      AllergyIntolerance: number;
      Condition: number;
      MedicationRequest: number;
    };
  } = null;

  let imagingStudies: StudyToFetch[] | null = null;
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

  let hotkeys = {};
  $: {
    if (!studyLoaded && imagingStudies) {
      hotkeys = _.chain(_.range(0, imagingStudies.length))
        .map((i) => [i + 1, () => fetchStudy(imagingStudies[i])])
        .fromPairs()
        .value();
    }
    else if (studyLoaded && !selectedSeries) {
      hotkeys = _.chain(_.range(0, studyLoaded.series.length))
        .map((i) => [i + 1, () => selectSeries(i)])
        .fromPairs()
        .value();
    }
  }

  onMount(() => {
    // Add event listener to window
    function listen(e: KeyboardEvent) {
      if (e.key === ">") {
        return nextInstance(1);
      }
      if (e.key === "<") {
        return nextInstance(-1);
      }
      hotkeys[e.key] && hotkeys[e.key]()
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

  $: studyLoaded && selectSeries(0);

  $: console.log("Study", studyLoaded);

  let selectedSeries: number | null = null;
  let selectedInstance = null;

  function parseStudyMetadata(study: Uint8Array[]) {
    cornerstoneWADOImageLoader.wadouri.fileManager.purge();
    cornerstoneWADOImageLoader.wadouri.dataSetCacheManager.purge();
    console.log("Purged previous studies from cache")

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
  let settingsOpen = false;
  function settingToggle() {
    settingsOpen = !settingsOpen;
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
    <!-- svelte-ignore a11y-click-events-have-key-events -->
    <div style="display: flex; gap: .5rem; align-items: center; cursor: pointer" on:click={settingToggle}>
      Settings<span class="material-icons">settings</span>
    </div>
  </nav>
</div>
<Settings on:save={settingToggle} bind:open={settingsOpen} />
<div class="container" style="position: relative;">
  <div class="row">
    <div class="col col-1 flexv">
      <div class="content-box">
        {#if $client === null}
          <select bind:value={selectedServerIndex}>
            {#each $settings?.clientConfig as server, i}
              <option value={i}>{server.label}</option>
            {/each}
          </select>
          <button on:click={beginAuthorization}>Connect</button>
        {:else if clinicalDetails}
          <h2>EHR Data</h2>
          <p>{clinicalDetails.name}</p>
          <p>{clinicalDetails.birthDate}</p>
          {#if Object.keys(clinicalDetails?.activeCounts || {}).length == 0}
            <p>Loading</p>
            <p>&nbsp;</p>
            <p>&nbsp;</p>
          {/if}
          {#each Object.keys(clinicalDetails.activeCounts || {}) as r}
            <p>{clinicalDetails.activeCounts[r] || "No "} active {r.split(".")[0]}s</p>
          {/each}
        {/if}
      </div>
      {#if $client || studyLoaded}
        <div class="content-box study-sidebar">
          {#if !studyLoaded}
            <h2>Imaging Studies</h2>
            {#each imagingStudies || [] as study, i}
              <button class="hotkey-button" disabled={studyDownloading} value={study.address} on:click={() => fetchStudy(study)}
                >Fetch {study.modality}
                  <span class="hotkey">{i + 1}</span>
                </button
              >
            {/each}
            {#if imagingStudies?.length === 0}
              <em>No studies available</em>
            {/if}
          {:else}
            <h2>
              Study Data (<a
                on:click={() => {
                  studyLoaded = null;
                  selectedSeries = null;
                  selectedInstance = null;
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
                <button class="hotkey-button" class:active={selectedSeries === i} on:click={() => selectSeries(i)}
                  >{series.name}
                  <span class="hotkey">{i + 1}</span>
                </button>
              {/each}
            </div>
          {/if}
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
    flex-direction: column;
  }

  .series-buttons {
    display: flex;
    flex-wrap: wrap;
  }

  button.hotkey-button {
    width: 100%;
    position: relative;
  }

  button.hotkey-button .hotkey {
    font-family: monospace;
    position: absolute;
    margin-left: 0.5em;
    left: 0;
  }

  .series-buttons .active {
    border: 1px solid var(--secondary-text-color);
  }

  .study-sidebar {
    flex-grow: 1;
  }
</style>
