# Getting Started

If you want to check out SMART Imaging Demo Stack, you can see it live at:

* https://imaging-app.argo.run is a Demo SMART Imaging App that can connect to any SMART on FHIR Clinical + Imaging endpoints.

* https://imaging.argo.run/smart-sandbox/fhir/ImagingStudy is a SMART on FHIR FHIR Imaging endpoint. Note that `smart-sandbox` can be replaced with other configuration keys to change server behavior. See <a href="#config">config section</a> below.


# Understanding the SMRAT Imaging Demo Stack

The SMART Imaging demo stack includes two main components:

## Sample app

See [`./viewer`](./viewer).

This app connects a SMART on FHIR clinical data server (e.g., an EHR sandbox) as well as an imaging erver (e.g., our Reference Imaging Server). After authorization, it retreives data from both. 


## Reference Imaging Server (FHIR + DICOM)
<a id="config"></a>

See [`./server`](./server).

### Flexible Behaviors

The Reference Imaging Server allows for testing SMART Imaging with many different servers. A complete configuration will provide two key components:

* Authorization server. Typically this will be an EHR's existing SMART on FHIR server (e.g., an EHR's sandbox authz server).
* Image source. Typically this will be a DICOM Web server that supports some kind of private authentication, but it could be something simpler like a folder full of test images in a demo environmnet. Anything that can recive a Patient and output a set of DICOM metadata + images.

### Pre-specified configurations (`https://imaging.argo.run/:key/fhir`) 

Pre-specified configurations are controlled by files in [`./server/config`](./server/config). They can change the behavior of the server to help you test out specific scenarios. For example:

  * `/smart-sandbox` configuration is backed by [`./server/config/smart-sandbox.json`](./server/config/smart-sandbox.json), which means that it will introspect access tokens against SMART's sandbox authorization server, so clients must use https://launch.smarthealthit.org to get an access token before making imaging requests.
  * `/open` configuration is backed by [`./server/config/open.json`](./server/config/open.json), which means that it will ignore access tokens entirely an just use a hard-coded introspection response. Similarly, it will ignore patient matching and always return the same set of images. These behaviors can be very handy for debugging.
  * For other keys, see [`./server/config`](./server/config)

### Dynamic Configuration (`https://imaging.argo.run/dyn/:encoded/fhir`) 

Dynamic configurations are useful when you want to get started testing SMART Imaging with your own EHR's authorization server. You can rapidly iterate on your config settings until you get something that works. These paths start with  `/dyn/:encoded`, where the variable component is `base64urlencode(JSON.stringify(config))`. For example, you might test out configurations dynamically until you're happy with the behavior; then you might email a few colleagues your base URL so they can test things out, and eventually you might submit a PR to this repository so a wider audience can reproduce this behavior.

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
