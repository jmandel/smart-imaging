#!/usr/bin/env bash
set -euo pipefail
cd /home/exedev/smart-imaging
docker run --rm --network smart-imaging-net -u root \
  -e ORTHANC_BASE=http://orthanc:8042 \
  -e ORTHANC_USERNAME=argonaut \
  -e ORTHANC_PASSWORD=argonaut \
  -v /home/exedev/smart-imaging/server/examples:/app/examples \
  -w /app/examples \
  smart-imaging-proxy:local run --allow-all load-examples.ts --wait-for-dicom-server
