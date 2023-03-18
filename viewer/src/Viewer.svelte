<!-- Viewer.svelte -->
<script>
  import { onMount, onDestroy } from 'svelte';
  import * as cornerstone from 'cornerstone-core';
  import * as cornerstoneTools from 'cornerstone-tools';

  export let imageId;

  let viewerElement;

  function loadImage(imageId) {
    if (!viewerElement) {
      return;
    }
    cornerstone.disable(viewerElement);
    cornerstone.enable(viewerElement);
    cornerstone.loadImage(imageId).then((image) => {
      cornerstone.displayImage(viewerElement, image);
    });
  }

  onMount(() => {
    loadImage(imageId);
  });

  onDestroy(() => {
    cornerstone.disable(viewerElement);
  });

  $: if (imageId) {
    loadImage(imageId);
  }
</script>

<style>
  .viewer {
    height: 800px;
    background-color: black;
    position: relative;
  }
</style>

<div class="viewer" bind:this={viewerElement}></div>
