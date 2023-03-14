# Setup

```
docker run -p 4242:4242 -p 8042:8042 --rm -v $(pwd)/orthanc-dw.json:/etc/orthanc/orthanc.json jodogne/orthanc-plugins
for v in ls jcm-mri/14631905/0*; do curl  -X POST -H "Expect:" http://orthanc:orthanc@localhost:8042/instances --data-binary @$v; done

deno run --allow-all --watch  qido.ts
curl http://localhost:8001/fhir/ImagingStudy?patient=Patient/87a339d0-8cae-418e-89c7-8651e6aab3c6
```

# Development Setup with minikube

1. Install `minikube` locally (tested with version 1.29)
2. Install `mkcert` locally (tested with 1.4.4)

```
minikube start
mkcert -install  "*.argo.run"
kubectl -n kube-system create secret tls mkcert \
    --key _wildcard.argo.run-key.pem \
    --cert _wildcard.argo.run.pem
minikube addons configure ingress # enter 'kube-system/mkcert'
minikube addons enable ingress
echo $(minikube ip)    imaging-local.argo.run | sudo tee -a /etc/hosts
eval $(minikube -p minikube docker-env)

git clone https://github.com/smart-on-fhir/smart-launcher-v2
cd smart-launcher-v2
docker build -t smartonfhir/smart-launcher-2 .
cd ..

git clone https://github.com/jmandel/smart-imaging-api
cd smart-imaging-api
docker build -t imaging-proxy .

kubectl apply -f k8s.yaml
```


## Access Services

* Open https://imaging-local.argo.run for SMART Launcher
* Open https://imaging-local.argo.run/orthanc (argonaut/argonaut) for Orthanc instance underlying the demo
* API at https://imaging-local.argo.run/img/smart-sandbox-local/fhir/ImagingStudy?patient= to query for imaging data



## After building new images

```
kubectl  -n smart-imaging-access rollout restart deployment reference
```

