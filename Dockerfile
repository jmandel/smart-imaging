ARG DENO_VERSION=1.31.1

FROM denoland/deno:bin-$DENO_VERSION AS deno

FROM ubuntu:latest
COPY --from=deno /deno /usr/local/bin/deno
RUN DEBIAN_FRONTEND=noninteractive apt-get update && apt-get -y install dcmtk &&  mkdir /app

WORKDIR /app
COPY clear.sh index.ts ./
ENTRYPOINT ["/usr/local/bin/deno", "run", "--allow-all", "index.ts", "/patient.json", "/target"]
