<!-- Viewer.svelte -->
<script>
  import { onMount, onDestroy } from "svelte";
  import * as cornerstone from "cornerstone-core";

  export let imageId;
  export let seriesIndex;

  let viewerElement;
  function loadImage(imageId, needReset = false) {
    if (!viewerElement) {
      return;
    }
    cornerstone.loadImage(imageId).then((image) => {
      cornerstone.displayImage(viewerElement, image);
      if (needReset) {
        cornerstone.reset(viewerElement)
      }
    });
  }

  onMount(() => {
    cornerstone.enable(viewerElement);
    loadImage(imageId, true);
  });

  onDestroy(() => {
    cornerstone.disable(viewerElement);
  });

  let prevSeriesIndex;
  $: {
    loadImage(imageId, seriesIndex != prevSeriesIndex)
    prevSeriesIndex = seriesIndex
  }
</script>

<div class="viewer" bind:this={viewerElement} />

<style>
  .viewer {
    height: 800px;
    position: relative;
  }
</style>
