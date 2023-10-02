FROM denoland/deno:ubuntu-1.37.1
RUN apt-get update && \
  apt-get install -y wget dcmtk
EXPOSE 8000
WORKDIR /app
USER deno
COPY  --chown=deno deno.lock src/deps.ts ./
RUN deno cache --reload --lock=deno.lock ./deps.ts
COPY --chown=deno . .
CMD ["run", "--allow-all", "src/index.ts"]
