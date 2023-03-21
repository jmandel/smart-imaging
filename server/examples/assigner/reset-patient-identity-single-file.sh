#!/bin/bash

target=$1
study=$2
series=$3
instance=$4
name=$5
mrn=$6
mrn_issuer=$7
birthdate=$8

echo "Updating $target metadata to"
echo "Name $name"
echo "MRN $mrn"
echo "MRN Issuer $mrn_issuer"

options="-nb -ie \
  -i \"PatientID=$mrn\" \
  -i \"IssuerOfPatientID=$mrn_issuer\" \
  -i \"TypeOfPatientID=TEXT\" \
  -i \"PatientName=$name\" \
  -m \"StudyInstanceUID=$study\" \
  -m \"SeriesInstanceUID=$series\" \
  -m \"SOPInstanceUID=$instance\" \
"

# Check if $birthdate is set and add option if necessary
if [[ -n "$birthdate" ]]; then
    options+=" -i \"PatientBirthDate=$birthdate\""
fi

echo dcmodify $options "$target"

# Run the dcmodify command with the options
eval "dcmodify $options \"$target\""

