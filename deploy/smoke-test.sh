#!/usr/bin/env bash
set -euo pipefail
BASE=${1:-http://localhost:8000}
ORTHANC=${2:-http://localhost:8042}
AUTH=${3:-argonaut:argonaut}
BASE=${BASE%/}
ORTHANC=${ORTHANC%/}

printf 'Smoke testing API %s and Orthanc %s\n' "$BASE" "$ORTHANC"

curl -fsS "$BASE/" >/dev/null
curl -fsS "$BASE/app/viewer/" | grep -q 'SMART Imaging'
curl -fsS "$BASE/app/viewer/" | grep -q 'assets/'

studies=$(curl -fsS "$BASE/open/fhir/ImagingStudy?patient=" | jq -r '.entry | length')
printf 'FHIR studies: %s\n' "$studies"
test "$studies" -gt 0

wado=$(curl -fsS "$BASE/open/fhir/ImagingStudy?patient=" | jq -r '.entry[0].resource.contained[0].address')
printf 'Sample WADO base URL: %s\n' "$wado"
echo "$wado" | grep -Fq "$BASE/open/wado/"
instances=$(curl -fsS -u "$AUTH" "$ORTHANC/instances" | jq -r 'length')
printf 'Orthanc instances: %s\n' "$instances"
test "$instances" -gt 0

curl -fsS "$BASE/smart-sandbox/fhir/metadata" | jq -e '.resourceType == "CapabilityStatement"' >/dev/null
printf 'OK\n'
