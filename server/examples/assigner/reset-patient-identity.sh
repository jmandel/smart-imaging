#!/bin/bash

target=$1
name=$2
mrn=$3
mrn_issuer=$4

echo "Updating $target metadata to"
echo "Name $name"
echo "MRN $mrn"
echo "MRN Issuer $mrn_issuer"

dcmodify -nb -ie -i "PatientID=$mrn" -i "IssuerOfPatientID=$mrn_issuer"  -i "TypeOfPatientID=TEXT" -i "PatientName=$name" $target
