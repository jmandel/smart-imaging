!/bin/bash

for s in $(cat sources.txt); do
    wget $s;
done

for f in *.bz2; do
    mkdir scratch; tar -xjvf $f -C scratch;
    cd scratch
    find . -name DICOMDIR | xargs rm
    find . -type f ! -name "*.*" -print0 | xargs -0 -I {}  mv "{}" "{}.dcm"
    tar -czvf ${f%.tar.bz2}.tgz *
    mv ${f%.tar.bz2}.tgz ..
    cd ..
    rm -rf scratch
done
