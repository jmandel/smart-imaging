import { derived, writable } from "svelte/store";

export interface Settings {
  source: string;
  clientConfig: {
    label: string;
    clinicalServer: string;
    imagingServer: string;
    clientId: string;
    scope?: string;
  }[];
}

import serversJson from "./config/servers.json";

export const settings = writable<Settings>(
  window.localStorage.getItem("settings")
    ? JSON.parse(window.localStorage.getItem("settings")!)
    : {
        clientConfig: serversJson.clientConfig,
      }
);

settings.subscribe((s) => {
  window.localStorage.setItem("settings", JSON.stringify(s));
});

export const settingsJson = derived(settings, ($settings: Settings) =>
  JSON.stringify({ ...$settings, source: undefined }, null, 2)
);
