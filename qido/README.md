# Setup

```
docker run -p 4242:4242 -p 8042:8042 --rm -v $(pwd)/orthanc-dw.json:/etc/orthanc/orthanc.json jodogne/orthanc-plugins
for v in ls jcm-mri/14631905/0*; do curl  -X POST -H "Expect:" http://orthanc:orthanc@localhost:8042/instances --data-binary @$v; done

deno run --allow-all --watch  qido.ts
curl http://localhost:8001/fhir/ImagingStudy?patient=Patient/87a339d0-8cae-418e-89c7-8651e6aab3c6
```
