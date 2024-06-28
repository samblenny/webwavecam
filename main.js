/* SPDX-License-Identifier: MIT */
/* SPDX-FileCopyrightText: Copyright 2024 Sam Blenny */
"use strict";

const STATUS = document.querySelector('#status');   // Status span
const CAM_BTN = document.querySelector('#camera');  // Camera button
const VIDEO = document.querySelector('#video');     // Video player
const CANVAS = document.querySelector('#canvas');   // Canvas (filter output)

const CTX = CANVAS.getContext("2d", {willReadFrequently: true});

// Detect if HTMLVideoElement.requestVideoFrameCallback can be used to sync
// frame filtering with the frame updates of the video preview element
const HAS_RVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

// Camera video stream
var STREAM = null;

// Update status line span
function setStatus(s) {
    STATUS.textContent = s;
}

// Return an array of 32-bit RGBA input converted to 8-bit Rec. 601 luma
function lumaFrom(rgba) {
    // Convert a 4-byte RGBA pixel to 1-byte approximate Rec. 601 luma (Y')
    // see: https://en.wikipedia.org/wiki/Luma_(video)
    //   Y'[601] = 0.299*R' + 0.587*G' + 0.114*B'
    // The official formula uses floating point coefficients, but the image
    // data is 8-bit unsigned integers. Since an approximation is fine here,
    // we can normalize the coefficients to 1*B' and round them to integers:
    //   Y' = (3*R' + 5*G' + 1*B') / 9
    // The sum of coefficients is 3 + 5 + 1 = 9, which is annoying. If the sum
    // was 8, we could use a shift (>>3). Approximating 5*G' as 4*G', gives:
    //   Y' = (3*R' + 4*G' + B') >> 3
    const luma = new Uint8ClampedArray(rgba.length >> 2);
    for (let i=0; i < rgba.length - 4; i += 4) {
        luma[i>>2] = ((3 * rgba[i]) + (4 * rgba[i+1]) + rgba[i+2]) >> 3;
    }
    return luma;
}

// Exapand pixel values from the luma array into the RGBA array as grayscale
function expandIntoRGBA(luma, rgba) {
    // luma is Uint8ClampedArray using 1 byte per pixel
    // rgba is Uing8ClampedArray using 4 bytes per pixel
    let i = 0;
    for (const Y of luma) {
        rgba[i] = Y;
        rgba[i+1] = Y;
        rgba[i+2] = Y;
        rgba[i+3] = 255;
        i += 4;
    }
}

// Invert brightness values of luma array (should be a Unint8ClampedArray)
function invert(luma) {
    let i = 0;
    for (const Y of luma) {
        luma[i] = 255 - Y;
        i++;
    }
}

// Forward Haar wavelet transform
function waveletFwdHaar(w, h, luma) {
    // Do a lifting scheme in-place Haar wavelet transform
    //   See "Building Your Own Wavelets at Home" course notes
    //   by Wim Sweldens and Peter Schröder
    //   Section 1.3 Haar and Lifting
    let rowBuf = new Uint8Array(w);
    let colBuf = new Uint8Array(h);
    // Loop over all the rows (horizontal average and difference)
    for (let y=0; y<h; y+=1) {
        const rowBase = y * w;
        // Transform (x, x+1) pixel pairs into (average, difference) pairs
        for (let x=0; x<w; x+=2) {
            // Scale Uint8 up by 4x and do intermediate math as Int32 (signed!)
            var a = luma[rowBase+x] << 2;
            var b = luma[rowBase+x+1] << 2;
            b = (b - a) >> 1;                  // Difference d/2 = (b - a)/2
            a = a + b;                         // Average      s = a + d/2
            // Store results in Uint8 buffer
            rowBuf[x>>1]          = (a >> 2) & 0xff;
            rowBuf[(w>>1)+(x>>1)] = (b >> 2) & 0xff;
        }
        // Overwrite the input pixels with buffer of averages and differences
        for (let x=0; x<w; x++) {
           luma[rowBase+x] = rowBuf[x];
        }
    }
    // Loop over all the columns (vertical average and difference)
    for (let x=0; x<w; x+=1) {
        // Transform (y, y+1) pixel pairs into (average, difference) pairs
        for (let y=0; y<h; y+=2) {
            const px0 = (y * w) + x;
            const px1 = px0 + w;
            // Scale Uint8 up by 4x and do intermediate math as Int32 (signed!)
            var a = luma[px0] << 2;
            var b = luma[px1] << 2;
            b = (b - a) >> 1;                  // Difference d/2 = (b - a)/2
            a = a + b;                         // Average      s = a + d/2
            // Store results in Uint8 buffer
            colBuf[y>>1]            = (a >> 2) & 0xff;
            colBuf[(h>>1) + (y>>1)] = (b >> 2) & 0xff;
        }
        // Overwrite the input pixels with buffer of averages and differences
        for (let y=0; y<h; y++) {
           luma[(y*w)+x] = colBuf[y];
        }
    }
}

// Inverse Haar wavelet transform
function waveletInvHaar(w, h, levels, luma) {
}

// Process video frames
function handleNewFrame(now, metadata) {
    // Copy video frame from video element to canvas element
    const w = VIDEO.videoWidth;
    const h = VIDEO.videoHeight;
    CANVAS.width = w;
    CANVAS.height = h;
    CTX.drawImage(VIDEO, 0, 0, w, h);
    // Apply filter to the pixels of the canvas element
    // getImageData returns RGBA Uint8ClampedArray of pixels in row-major order
    const imageData = CTX.getImageData(0, 0, w, h);
    const rgba = imageData.data;
    var luma = lumaFrom(rgba);
    // -- begin filter chain ---

    waveletFwdHaar(w, h, luma);
    // invert(luma);

    // --- end filter chain ---
    // Draw the luma values back to the canvas as RGBA pixels
    expandIntoRGBA(luma, rgba);
    CTX.putImageData(imageData, 0, 0);
    // Schedule a callback for the next frame
    if (HAS_RVFC) {
        VIDEO.requestVideoFrameCallback(handleNewFrame);
    }
}

// Attempt to open video stream from default camera
function startVideo() {
    const constraints = {video: {
        width: 320,
        height: 320,
        facingMode: "environment",
        frameRate: 15,
    }};
    if (! navigator.mediaDevices) {
        console.log("navigator.mediaDevices missing... iOS lockdown mode?");
        alert("It looks like you might be using an iOS device with lockdown "
         + "mode enabled. If so, you will need to grant an exception for this "
         + "page in order to use the camera: 'AA' menu in URL bar > Website "
         + "Settings > Lockdown Mode > [turn switch off]");
        return;
    }
    navigator.mediaDevices.getUserMedia(constraints)
    .then((stream_) => {
        // Update HTML button
        CAM_BTN.classList.add('on');
        CAM_BTN.textContent = 'pause';
        // Save reference to stream
        STREAM = stream_;
        // Watch for possible USB camera unplugged event (among other things)
        navigator.mediaDevices.ondevicechange = deviceChange;
        // Update status line with camera name
        let cameras = [];
        for(let t of stream_.getTracks()) {
            cameras.push(t.label);
        }
        setStatus(cameras.join(", "));
        // Start live preview of video stream
        VIDEO.srcObject = stream_;
        if (HAS_RVFC) {
            VIDEO.requestVideoFrameCallback(handleNewFrame);
        } else {
            console.log("HTMLElement.requestVideoFrameCallback not supported");
        }
        try {
            VIDEO.play();
        } catch (err) {
            console.log("video.play()", err);
        }
    })
    .catch((err) => {
        setStatus("failed to start camera");
        console.log("unable to open video stream", err);
        alert("I wasn't able to open any cameras. Maybe your privacy settings "
            + "don't allow camera access, or perhaps a cable is unplugged.");
    });
}

// Handle possibility of USB webcam being suddenly unplugged
function deviceChange(d) {
    if(STREAM && !STREAM.active) {
        pauseVideo();
        setStatus("paused (lost video stream)");
    }
}

// Pause playback at current frame, then let go of camera's video stream
function pauseVideo() {
    VIDEO.pause();    // freeze video playback at current frame
    CAM_BTN.classList.remove('on');
    CAM_BTN.textContent = 'Start Camera';
    for(let t of STREAM.getTracks()) {
        t.stop();     // turn off camera (LED should go off)
    }
    STREAM = null;
    setStatus("paused");
}

// Add camera on/off event handlers to the camera button
CAM_BTN.addEventListener('click', function() {
    if(CAM_BTN.classList.contains('on')) {
        // Camera was on, so turn it off
        pauseVideo();
    } else {
        // Camera was off, so attempt to turn it on
        startVideo();
    }
});

setStatus("ready");
