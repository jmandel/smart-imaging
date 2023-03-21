# Assign FHIR Patient into DICOM Files

## Run in Docker

Mount a FHIR Patient JSON file to `/patient.json` and a directory containing a DICOM study to `/target`.

```
docker build -t fhir-into-dicom .

docker run --rm \
  --mount type=bind,source="$(pwd)"/patient-example.json,target=/patient.json
  --mount type=bind,source="$(pwd)"/example-study,target=/target \
  fhir-into-dicom
```
