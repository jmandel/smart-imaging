#!/bin/bash

mkdir scratch
pushd scratch

for v in $(cat ../sources.txt);
do
    wget $v;
done

tar -xzvf *.tgz;

for i in $(find . -name *.dcm);
do
    echo "POSTing $i"
    wget --auth-no-challenge \
    --user argonaut \
    --password argonaut \
    -O /dev/null \
    http://orthanc:8042/instances \
    --post-file="$i"
done

popd
rm -rf scratch
