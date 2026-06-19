# exe.dev deployment notes

This VM runs the demo with two systemd services:

- `smart-imaging-orthanc.service` — Orthanc DICOM/DICOMweb on localhost:8042 and DIMSE 4242.
- `smart-imaging-api.service` — Deno SMART Imaging API + bundled viewer on port 8000.

External URL: https://imaging.exe.xyz/

The API container uses `BASE_URL=https://imaging.exe.xyz` so generated FHIR Endpoint/WADO URLs are public. Internally, it still reaches Orthanc at `http://orthanc:8042` on Docker network `smart-imaging-net`; this avoids relying on the exe.dev public hostname from inside the VM.

Reload sample DICOM data with:

```sh
./deploy/load-examples.sh
```
