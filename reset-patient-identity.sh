#!/bin/bash

target=$1
name=$2
mrn=$3
mrn_issuer=$4

echo "Clearing $target"
echo "Updating metadata to"
echo "Name $name"
echo "MRN $mrn"
echo "MRN Issuer $mrn_issuer"

pushd $target
rm DICOMDIR || true

dicom_root="."

if [ -d "DICOM" ]; then
  dicom_root="./DICOM"
fi

for df in $(find $dicom_root -type f); do
    echo "In $(pwd); Modifying $df"
    dcmodify -nb -ie \
      -ea OtherPatientIDsSequence \
      -ea PatientID \
      -ea PatientName \
      -ea PatientBirthName \
      -ea PatientAge \
      -ea IssuerOfPatientID \
      -ea TypeOfPatientID \
      -ea IssuerOfPatientIDQualifiersSequence  \
      -ea PatientBirthDate \
      -ea PatientBirthTime \
      -ea PatientBirthDateInAlternativeCalendar \
      -ea PatientDeathDateInAlternativeCalendar \
      -ea PatientAlternativeCalendar  \
      -ea PatientSex \
      -ea PatientInsurancePlanCodeSequence \
      -ea PatientPrimaryLanguageCodeSequence \
      -ea PatientPrimaryLanguageModifierCodeSequence  \
      -ea PatientAddress \
      -ea PatientMotherBirthName  \
      -ea PatientTelephoneNumbers  \
      -ea PatientTelecomInformation  \
      -ea AdditionalPatientHistory  \
      -ea PatientReligiousPreference  \
      -ea PatientReligiousPreference  \
      -ea PatientInstitutionResidence  \
      -ea PatientState $df
    dcmodify -nb -ie -i "PatientID=$mrn" -i "IssuerOfPatientID=$mrn_issuer"  -i "TypeOfPatientID=TEXT" -i "PatientName=$name" $df
done;

# dcmmkdir --recurse DICOM
