export function appBaseUrl() {
  const assetScript = Array.from(document.scripts).find((script) => script.src.includes('/assets/'));
  if (assetScript?.src) return new URL('../', assetScript.src);
  const href = window.location.href.endsWith('/') ? window.location.href : `${window.location.href}/`;
  return new URL('./', href);
}

export function appAssetUrl(path: string) {
  return new URL(path, appBaseUrl()).href;
}
