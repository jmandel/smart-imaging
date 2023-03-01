const pt = JSON.parse(Deno.readTextFileSync(Deno.args[0]));
const nameFamily = pt.name?.[0]?.family;
const nameGiven = pt.name?.[0]?.given?.join(" ");
const mrn = pt.identifier.filter((i) =>
  i.type?.coding.some((c) => c.code == "MR")
)?.[0];

const command = new Deno.run({
  //stdout: "piped",
  //stderr: "piped",
  cmd: [
    "./reset-patient-identity.sh",
    Deno.args[1],
    `${nameFamily || "unknown"}^${nameGiven || "unknown"}^^^`,
    `${mrn.value}`,
    `${mrn.system}`,
  ],
});

const status = await command.status();
console.log("Status", status);
