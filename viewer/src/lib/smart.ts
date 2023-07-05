import { writable } from "svelte/store";

import * as fhirclient from "fhirclient";
// const fhirclient = FHIR;

import type Client from "fhirclient/lib/Client";
import type { Settings } from "../settings";

export type Client = Client;

export function create() {
  const client = writable<Client>(null);
  fhirclient.oauth2.ready().then(client.set);
  return client;
}

export const client = create();
export const authorize = (config: (Settings["clientConfig"][number])) => {
  fhirclient.oauth2.authorize({ ...config });
};
