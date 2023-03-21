#!/bin/bash
while true;do
echo "Waiting for service"
wget --quiet -O /dev/null -T 15 -c http://argonaut:argonaut@orthanc:8042/instances && break
sleep 5
done
