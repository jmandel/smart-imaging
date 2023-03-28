import { writable } from "svelte/store";

import * as fhirclient from "fhirclient";
import type Client from "fhirclient/lib/Client";
import type * as ftypes from "fhirclient/lib/types";
import type { Settings } from "../settings";

type ModifiedClient = Client & {
  images: () => Promise<any>;
};
export type { ModifiedClient as Client };

export function create(imagingServer?: string) {
  const client = writable<ModifiedClient>(null);

  try {
    fhirclient.oauth2.ready().then((c) => {
      const cstate = c.state as typeof c.state & ClientConfig;
      (c as unknown as ModifiedClient).images = async function images() {
        const ibundle = await c.request(imagingServer + "/ImagingStudy?patient=" + cstate.tokenResponse.patient);
        return ibundle;
      };
      client.set(c as ModifiedClient);
    });
  } catch { }
  return client;
}

let imagingServer = sessionStorage.getItem("imagingServer");
export const client = create(imagingServer);
export type ClientConfig = ftypes.fhirclient.AuthorizeParams & {
  imagingServer: string;
};
export const authorize = (config: (ClientConfig & Settings["clientConfig"][number])) => {
  sessionStorage.setItem("imagingServer", config.imagingServer);
  fhirclient.oauth2.authorize({ ...config, iss: config.clinicalServer});
};
