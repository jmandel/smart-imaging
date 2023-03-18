#!/bin/bash

set -e

mkdir scratch
pushd scratch

for v in $(cat ../sources.txt);
do
    wget $v;
done

for v in $(ls *.tgz);
do
    echo "Untar $v";
    tar -xzvf "$v";
done

find . -name *.dcm -print0 | while IFS= read -r -d $'\0' file;
do
    echo "POSTing $file"
    wget --auth-no-challenge \
    --user argonaut \
    --password argonaut \
    -O /dev/null \
    http://orthanc:8042/instances \
    --post-file="$file"
done

popd
rm -rf scratch
