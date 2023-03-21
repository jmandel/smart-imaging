# Getting Started

If you want to check out SMART Imaging Demo Stack, you can see it live at:

* https://imaging-app.argo.run . Demo SMART App that connects to a SMART on FHIR Clinical + Imaging endpoints.

* https://imaging.argo.run/img/smart-sandbox/fhir/ImagingStudy. FHIR Imaging endpoint. This configuration is backed a small set of imaging data and protected by SMART's sandbox authoirzation server, so clients will use https://launch.smarthealthit.org to get an access token before making imaging requests. Note that `smart-sandbox` can be replaced with another configuration key or with a dynamic config value to leverage a different SMART authorization server or image source.


# Understanding the SMRAT Imaging Demo Stack

The SMART Imaging demo stack includes two main components:

## Sample app

See `viewer` folder.

This app connects a SMART on FHIR clinical data server (e.g., an EHR sandbox) as well as an imaging erver (e.g., our Reference Imaging Server). After authorization, it retreives data from both. 


## Reference Imaging Server (FHIR + DICOM)

See `server` folder.

The Imaging Server is designed for flexibility in testing and development. It can be configured at runtime through 

* configuration files (see `server/config` for our commonly used, publicly available configurations), or
* dynamic path components (useful if you want to try out SMART Imaging with your own EHR's authorization server, for example).  These look like `/dyn/:config`, where the variable component is `base64urlencode(JSON.stringify(config))`. This saves you a step if you want to iterate on a server config without submitting PRs to this repository, and without hosting your own copy of the Reference Imaging Server.

Through configuration, the Reference Imaging Server depends on two key components:
* Authorization server. Typically this will be an EHR's existing SMART on FHIR server (e.g., an EHR's sandbox authz server).
* Image source. Typically this will be a DICOM Web server that supports some kind of private authentication, but it could be something simpler like a folder full of test images in a demo environmnet. Anything that can recive a Patient and output a set of DICOM metadata + images.


---

  
# Development Setup with minikube

1. Install `minikube` locally (tested with version 1.29)
2. Install `mkcert` locally (tested with 1.4.4)

```
minikube start
mkcert -install  "*.imaging-local.argo.run" "imaging-local.argo.run"
kubectl -n kube-system create secret tls mkcert \
    --key _wildcard.argo.run-key.pem \
    --cert _wildcard.argo.run.pem
minikube addons configure ingress # enter 'kube-system/mkcert'
minikube addons enable ingress
echo $(minikube ip)    imaging-local.argo.run | sudo tee -a /etc/hosts
echo $(minikube ip)    launcher.imaging-local.argo.run | sudo tee -a /etc/hosts
eval $(minikube -p minikube docker-env)

git clone https://github.com/smart-on-fhir/smart-launcher-v2
cd smart-launcher-v2
docker build -t argonautcontainerregistry.azurecr.io/smartonfhir/smart-launcher-2 .
cd ..

git clone https://github.com/jmandel/smart-imaging-api
cd smart-imaging-api
docker build -t argonautcontainerregistry.azurecr.io/imaging-proxy .

kubectl apply -f k8s/base.yml -f k8s/minikube.yml
```


## Access Services

* Open https://imaging-local.argo.run for SMART Launcher
* Open https://imaging-local.argo.run/orthanc (argonaut/argonaut) for Orthanc instance underlying the demo
* API at https://imaging-local.argo.run/img/smart-sandbox-local/fhir/ImagingStudy?patient= to query for imaging data

### Local API examples

```
curl https://imaging-local.argo.run/img/open/fhir/ImagingStudy?patient=Patient/87a339d0-8cae-418e-89c7-8651e6aab3c6
```



## After building new images

```
kubectl  -n smart-imaging-access rollout restart deployment reference
```

# Deploying to hosted demo

```
kubectl apply -f k8s/base.yml k8s/server.yml
```
