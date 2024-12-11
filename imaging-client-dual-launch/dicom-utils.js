// Multipart parsing function
export async function parseMultipart(response) {
    const contentType = response.headers.get("Content-Type");
    const boundary = contentType.match(/boundary="?([^";]+)"?/)[1];
    const crlfBoundaryBytes = new TextEncoder().encode(`\r\n--${boundary}`);
    const noCrlfBoundaryBytes = new TextEncoder().encode(`--${boundary}`);

    const data = new Uint8Array(await response.arrayBuffer());
    let state = "preamble";
    let headerStart = -1;
    let headerEnd = -1;
    const parts = [];

    function processPart(end) {
        const headerBytes = data.subarray(headerStart, headerEnd);
        const headerText = new TextDecoder().decode(headerBytes).trim();
        const headers = new Headers();

        for (const line of headerText.split(/\r\n/)) {
            if (!line.match(":")) continue;
            const [name, value] = line.split(": ");
            headers.append(name.toLowerCase(), value);
        }

        const body = data.subarray(headerEnd + 4, end + 1);
        parts.push({ headers, body });
    }

    let matchCount = 0;
    let boundaryBytes = noCrlfBoundaryBytes;

    for (let i = 0; i < data.length; i++) {
        if (data[i] === boundaryBytes[matchCount]) {
            matchCount++;
        } else {
            matchCount = 0;
        }

        if (state === "header") {
            if (data.subarray(i - 3, i + 1).every((v, j) => v === "\r\n\r\n".charCodeAt(j))) {
                state = "body";
                headerEnd = i - 3;
            }
        }

        if (matchCount === boundaryBytes.length) {
            if (state === "preamble") {
                state = "header";
                headerStart = i + 1;
                boundaryBytes = crlfBoundaryBytes;
            } else if (state === "body") {
                processPart(i - boundaryBytes.length);
                state = "header";
                headerStart = i + 1;
            }
            matchCount = 0;
        }
    }

    return {
        headers: response.headers,
        parts,
    };
}

// New loading function
export async function loadDicomStudy(endpoint, studyUid, token, progressCallback) {
    const response = await fetch(`${endpoint}/studies/${studyUid}`, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'multipart/related; type=application/dicom'
        }
    });

    const reader = response.body.getReader();
    const contentLength = parseInt(response.headers.get('Content-Length') || '0');
    let receivedLength = 0;
    let chunks = [];

    // Read the stream
    while(true) {
        const {done, value} = await reader.read();
        if (done) break;
        
        chunks.push(value);
        receivedLength += value.length;
        
        if (progressCallback) {
            progressCallback(receivedLength, contentLength);
        }
    }

    // Concatenate chunks
    const allChunks = new Uint8Array(receivedLength);
    let position = 0;
    for (const chunk of chunks) {
        allChunks.set(chunk, position);
        position += chunk.length;
    }

    // Parse multipart response
    const parts = await parseMultipart(new Response(allChunks, response));
    
    // Create instances array with blob URLs
    return parts.parts.map(part => {
        const blob = new Blob([part.body]);
        const imageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(blob);
        return { imageId, metadata: null };
    });
}

// Enhanced display function
export async function initializeViewer(element) {
    await cornerstone.enable(element);
    
    // Add resize handler
    const resizeHandler = () => {
      try {
        cornerstone.resize(element);
        cornerstone.fitToWindow(element);
      } catch {}
    };
    window.removeEventListener('resize', resizeHandler);
    window.addEventListener('resize', resizeHandler);

    return resizeHandler;
}

// DICOM display functions
export async function displayDicomImage(element, image, instance, sliceInfo, index, totalInstances) {
    try {
        // Get the underlying DICOM dataset directly
        if (image && image.data && image.data.elements) {
            const seriesNumber = image.data.string('x00200011');
            const seriesDescription = image.data.string('x0008103e');
            
            instance.metadata = {
                seriesNumber: seriesNumber || 'Unknown',
                seriesDescription: seriesDescription || ''
            };
        }
        
        // Update series information display
        const seriesInfo = document.getElementById('seriesInfo');
        seriesInfo.textContent = `Series ${instance.metadata.seriesNumber}${instance.metadata.seriesDescription ? ': ' + instance.metadata.seriesDescription : ''}`;
        
        // Display image with auto-adjusted viewport
        const viewport = cornerstone.getDefaultViewportForImage(element, image);
        
        // Enable VOI LUT auto-adjustments
        if (image.maxPixelValue === undefined) {
            const maxVoi = image.maxPixelValue || viewport.voi.windowWidth || 255;
            viewport.voi = {
                windowWidth: maxVoi,
                windowCenter: maxVoi / 2
            };
        }
        
        cornerstone.displayImage(element, image, viewport);
        cornerstone.fitToWindow(element);
        
        // Update slice info with the provided index and total
        if (sliceInfo) {
            sliceInfo.textContent = `${index + 1}/${totalInstances}`;
        }
    } catch (error) {
        console.log('Error displaying image:', error);
    }
} 
