<!-- Thumbnail.svelte -->
<script>
  import { onMount } from "svelte";
  import * as cornerstone from "cornerstone-core";

  export let imageId = "";


  async function displayImageId(id){
    let image = await cornerstone.loadImage(id);
    cornerstone.displayImage(canvas, image);
  }

  $: {
    displayImageId(imageId)
    console.log("IID", imageId, "in thumb");
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