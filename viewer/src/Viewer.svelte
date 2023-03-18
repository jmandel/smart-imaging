<!-- Viewer.svelte -->
<script>
  import { onMount, onDestroy } from "svelte";
  import * as cornerstone from "cornerstone-core";
  import * as cornerstoneTools from "cornerstone-tools";

  export let imageId;

  let viewerElement;

  function loadImage(imageId) {
    if (!viewerElement) {
      return;
    }
    cornerstone.loadImage(imageId).then((image) => {
      cornerstone.displayImage(viewerElement, image);
    });
  }

  onMount(() => {
    cornerstone.enable(viewerElement);
    loadImage(imageId);
  });

  onDestroy(() => {
    cornerstone.disable(viewerElement);
  });

  $: loadImage(imageId);
</script>

<div class="viewer" bind:this={viewerElement} />

<style>
  .viewer {
    height: 800px;
    background-color: black;
    position: relative;
  }
</style>
