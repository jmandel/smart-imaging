<script lang="ts">
  export let open: boolean = false;
  import { settings, settingsJson, settingsResettable } from "./settings";

  let editableSettings: string;

  function ingestSettings(_$settings?) {
    editableSettings = $settingsJson;
  }

  function factoryReset() {
    settings.factoryReset()
  }

  $: {
    ingestSettings($settings);
  }
</script>

{#if open}
  <div class="modal">
    <div class="container fullheight" style="position: relative;">
      <div class="row fullheight">
        <div class="col col-4 content-box fullheight">
          <textarea bind:value={editableSettings} />
          <button
            on:click={() => {
              $settings = { source: editableSettings, ...JSON.parse(editableSettings) };
              open = false;
            }}>Save Settings</button
          >
          <button on:click={() => { ingestSettings(); open = false; }}>Discard changes</button>
          <button on:click={factoryReset} disabled={!$settingsResettable}>
            {#if settings.factoryUpdatesAvailable()}
              !
            {/if}
            Reset all to defaults</button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  textarea {
    height: calc(100% - 3em);
  }
  .fullheight {
    height: 100%;
  }

  .modal {
    position: absolute;
    width: 100%;
    height: calc(100% - 5em);
    z-index: 10;
    box-sizing: border-box;
    background-color: var(--background-color);
  }
</style>