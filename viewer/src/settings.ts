import { derived, writable } from "svelte/store";

export interface Settings {
  clientConfig: {
    label: string;
    iss: string;
    clientId: string;
    scope?: string;
  }[];
}

import serversJson from "./config/servers.json";

function factorySettings() {
  return {
    clientConfig: serversJson.clientConfig,
  };
}
export const settings = {
  ...writable<Settings>(
    window.localStorage.getItem("settings") ? JSON.parse(window.localStorage.getItem("settings")!) : factorySettings()
  ),
  factoryUpdatesAvailable() {
    const lastFactory = window.localStorage.getItem("settingsFactory");
    const thisFactory = JSON.stringify(factorySettings());
    return lastFactory && thisFactory !== lastFactory;
  },
  factoryReset() {
    this.set(factorySettings());
  },
};

settings.subscribe((s: Settings) => {
  const toStore = JSON.stringify(s);
  const toStoreFactory = JSON.stringify(factorySettings());

  if (toStore === toStoreFactory) {
    window.localStorage.removeItem("settings");
    window.localStorage.removeItem("settingsFactory");
  } else {
    const fullStorage = JSON.stringify(s);
    if (fullStorage !== window.localStorage.getItem("settings")) {
      window.localStorage.setItem("settings", JSON.stringify(s));
      window.localStorage.setItem("settingsFactory", toStoreFactory);
    }
  }
});

export const settingsJson = derived(settings, ($settings: Settings) =>
  JSON.stringify({ ...$settings}, null, 2)
);

export const settingsResettable = derived(
  settings,
  ($settings: Settings) => JSON.stringify({ ...$settings}) !== JSON.stringify(factorySettings())
);
