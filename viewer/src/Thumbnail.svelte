<!-- Thumbnail.svelte -->
<script>
  import { onMount } from "svelte";
  import * as cornerstone from "cornerstone-core";

  export let imageId = "";

  $: {
    console.log("IID", imageId, "in thumb");
    cornerstone.loadImage(imageId).then((image) => {
      console.log("Loaded");
      cornerstone.displayImage(canvas, image);
    });
  }

  let canvas;

  onMount(() => {
    cornerstone.enable(canvas);

    return () => {
      cornerstone.disable(canvas);
    };
  });
</script>

<div class="viewer" bind:this={canvas}  ></div>