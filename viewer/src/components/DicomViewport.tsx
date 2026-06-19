import React, { useEffect, useRef } from 'react';
import * as cornerstone from 'cornerstone-core';

type Props = { imageId: string | null };
export function DicomViewport({ imageId }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current; if (!el) return;
    cornerstone.enable(el);
    return () => { try { cornerstone.disable(el); } catch {} };
  }, []);
  useEffect(() => {
    const el = ref.current; if (!el || !imageId) return;
    cornerstone.loadImage(imageId).then((image:any) => { cornerstone.displayImage(el, image); cornerstone.fitToWindow(el); });
  }, [imageId]);
  return <div ref={ref} style={{width:'100%', height:'65vh', background:'#050505'}} />;
}
