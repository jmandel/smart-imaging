import { ensureDir } from "https://deno.land/std@0.180.0/fs/mod.ts";
import { walk } from "https://deno.land/std@0.180.0/fs/mod.ts";
import { parse } from "https://deno.land/std@0.180.0/flags/mod.ts";
import * as path from "https://deno.land/std/path/mod.ts";

const scratchDir = "./scratch";

const ORTHANC_BASE = Deno.env.get("ORTHANC_BASE") || `http://orthanc:8042`;
const ORTHANC_USERNAME = Deno.env.get("ORTHANC_USERNAME") || `argonaut`;
const ORTHANC_PASSWORD = Deno.env.get("ORTHANC_PASSWORD") || `argonaut`;
const authz = { Authorization: "Basic " + btoa(`${ORTHANC_USERNAME}:${ORTHANC_PASSWORD}`) };

async function waitForOrthancServer() {
  while (true) {
    try {
      const response = await fetch(ORTHANC_BASE + "/instances", {
        method: "GET",
        headers: new Headers(authz),
      });

      if (response.ok) {
        break;
      }
    } catch (error) {
      // just keep waiting
      console.log("Error waaiting", new Date().toISOString(), error)
    }
    console.log("Waiting for DICOM server");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function downloadFile(url: string, dest: string) {
  const response = await fetch(url);
  if (response.body) {
    const file = await Deno.open(dest, { write: true, create: true });
    await response.body.pipeTo(file.writable);
  }
}

async function untarFile(file: string) {
  const process = Deno.run({
    cmd: ["tar", "-xzvf", file],
    stdout: "null",
  });
  await process.status();
}

async function uploadDicomFile(filePath: string) {
  const file = await Deno.open(filePath, { read: true });
  await fetch(ORTHANC_BASE + "/instances", {
    method: "POST",
    headers: new Headers(authz),
    body: file.readable,
  });
}

async function computeSha256(json: any): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(json));
  const digest = await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(10))
    .join("");
}

async function getNewUids(dicomFilePath: string, identityFilePath: string, prefix = "1.3.6.1.4.1.37476.9000.163") {
  console.log(`Processing file: ${dicomFilePath}`);

  const studyUID = await getUID(dicomFilePath, "StudyInstanceUID");
  const seriesUID = await getUID(dicomFilePath, "SeriesInstanceUID");
  const instanceUID = await getUID(dicomFilePath, "SOPInstanceUID");

  const format = async (uid: string) =>
    prefix + "." + (await computeSha256({ uid, identityFilePath })).slice(0, 64 - prefix.length - 1);

  return {
    studyUID: await format(studyUID),
    seriesUID: await format(seriesUID),
    instanceUID: await format(instanceUID),
  };
}

async function getUID(filePath: string, tag: string): Promise<string> {
  const result = await Deno.run({
    cmd: ["dcmdump", "+P", tag, filePath],
    stdout: "piped",
  });

  const output = new TextDecoder().decode(await result.output());
  const match = output.match(/(\[.*\])/);
  if (match) {
    return match[1].slice(1, -1);
  } else {
    throw new Error(`Unable to find UID for tag ${tag} in file ${filePath}`);
  }
}

async function remapDicomFile(dicomFilePath: string, identityFilePath: string) {
  const pt = JSON.parse(Deno.readTextFileSync(path.join("..", identityFilePath)));
  const nameFamily = pt.name?.[0]?.family;
  const nameGiven = pt.name?.[0]?.given?.join(" ");
  const mrn = pt.identifier[0]
  const birthDate = pt.birthDate;

  const newUids = await getNewUids(dicomFilePath, identityFilePath);
  console.log("mrn", mrn);
  console.log("bday", birthDate);

  const command = Deno.run({
    cmd: [
      path.join("..", "assigner", "reset-patient-identity-single-file.sh"),
      dicomFilePath,
      newUids.studyUID,
      newUids.seriesUID,
      newUids.instanceUID,

      `${nameFamily || "unknown"}^${nameGiven || "unknown"}^^^`,
      `${mrn.value}`,
      `${mrn.system}`,
      `${birthDate}`,
    ],
  });

  const status = await command.status();
  console.log("Status", status);
}

async function readJson(filePath: string) {
  return JSON.parse(await Deno.readTextFile(filePath));
}

async function main() {
  const args = parse(Deno.args, { "--": false });
  const waitForDicomServer = args["wait-for-dicom-server"] || false;

  if (waitForDicomServer) {
    await waitForOrthancServer();
  }

  const examples = (await readJson("sources.json")) as Array<{ url: string; mapIdentity: string[] }>;

  for (const [index, example] of examples.entries()) {
    if (!example.mapIdentity?.length){
      continue;
    }
    await ensureDir(scratchDir);
    Deno.chdir(scratchDir);

    const dest = `file_${index}.tgz`;
    await downloadFile(example.url, dest);
    await untarFile(dest);
    for (const identityFilePath of example.mapIdentity) {
      for await (const entry of walk(".", { exts: [".DCM", ".dcm"] })) {
        await Deno.copyFile(entry.path, "temp");
        await remapDicomFile(entry.path, identityFilePath);
        await uploadDicomFile(entry.path);
        await Deno.copyFile("temp", entry.path);
      }
    }

    Deno.chdir("..");
    await Deno.remove(scratchDir, { recursive: true });
  }
}

await main();
