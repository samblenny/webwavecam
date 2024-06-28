/* SPDX-License-Identifier: MIT */
/* SPDX-FileCopyrightText: Copyright 2024 Sam Blenny */
"use strict";

const STATUS = document.querySelector('#status');   // Status span
const CAM_BTN = document.querySelector('#camera');  // Camera button
const VIDEO = document.querySelector('#video');     // Video player
const CANVAS = document.querySelector('#canvas');   // Canvas (filter output)

const CTX = CANVAS.getContext("2d", {willReadFrequently: true});

// Wavelet Transform Controls
const INV_WAVE = document.querySelector('#invWave');  // Inv. wavelet checkbox
const INV_LUMA = document.querySelector('#invLuma');  // Inv. luma checkbox
// Noise gate thresholds
const NGATE1 = document.querySelector('#ngate1');
const NGATE2 = document.querySelector('#ngate2');
const NGATE3 = document.querySelector('#ngate3');
const NGATE4 = document.querySelector('#ngate4');
const NGATE5 = document.querySelector('#ngate5');
const NGATE6 = document.querySelector('#ngate6');
// Gain reduction (right shift by 0..7 bits)
const GAIN1 = document.querySelector('#gain1');
const GAIN2 = document.querySelector('#gain2');
const GAIN3 = document.querySelector('#gain3');
const GAIN4 = document.querySelector('#gain4');
const GAIN5 = document.querySelector('#gain5');
const GAIN6 = document.querySelector('#gain6');
// Luma bias (+1 left shifted by 0..7 bits)
const BAIS1 = document.querySelector('#bais1');
const BAIS2 = document.querySelector('#bais2');
const BAIS3 = document.querySelector('#bais3');
const BAIS4 = document.querySelector('#bais4');
const BAIS5 = document.querySelector('#bais5');
const BAIS6 = document.querySelector('#bais6');


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
    const luma = new Uint8Array(rgba.length >> 2);
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
function waveletFwdHaar(w, h, levels, luma) {
    // Do a lifting scheme in-place Haar wavelet transform
    //   See "Building Your Own Wavelets at Home" course notes
    //   by Wim Sweldens and Peter Schröder
    //   Section 1.3 Haar and Lifting
    let rowBuf = new Uint8Array(w);
    let colBuf = new Uint8Array(h);
    for (let level=0; level<=levels; level++) {
        // cols and rows define the pixel buffer subregion that the current
        // level of the wavelet transform operates on. Level 1 does the whole
        // pixel buffer, level 2 does only the top left quadrant, and so on.
        const cols = w >> (level-1);
        const rows = h >> (level-1);
        // Loop over all the rows (horizontal average and difference)
        for (let y=0; y<rows; y+=1) {
            const rowBase = y * w;
            // Transform (x, x+1) pixel pairs into (average, difference) pairs
            for (let x=0; x<cols; x+=2) {
                // Scale Uint8 up by 4x and do intermediate math as Int32
                var a = luma[rowBase+x] << 2;
                var b = luma[rowBase+x+1] << 2;
                b = (b - a) >> 1;                // Difference d/2 = (b - a)/2
                a = a + b;                       // Average      s = a + d/2
                // Store results in Uint8 buffer
                rowBuf[x>>1]        = (a >> 2) & 0xff;
                rowBuf[(cols+x)>>1] = (b >> 2) & 0xff;
            }
            // Overwrite input pixels with buffer of averages and differences
            for (let x=0; x<cols; x++) {
               luma[rowBase+x] = rowBuf[x];
            }
        }
        // Loop over all the columns (vertical average and difference)
        for (let x=0; x<cols; x+=1) {
            // Transform (y, y+1) pixel pairs into (average, difference) pairs
            for (let y=0; y<rows; y+=2) {
                const px0 = (y * w) + x;
                const px1 = px0 + w;
                // Scale Uint8 up by 4x and do intermediate math as Int32
                var a = luma[px0] << 2;
                var b = luma[px1] << 2;
                b = (b - a) >> 1;                // Difference d/2 = (b - a)/2
                a = a + b;                       // Average      s = a + d/2
                // Store results in Uint8 buffer
                colBuf[y>>1]        = (a >> 2) & 0xff;
                colBuf[(rows+y)>>1] = (b >> 2) & 0xff;
            }
            // Overwrite input pixels with buffer of averages and differences
            for (let y=0; y<rows; y++) {
               luma[(y*w)+x] = colBuf[y];
            }
        }
    }
}

// Inverse Haar wavelet transform
function waveletInvHaar(w, h, levels, luma, noiseGates, gains, biases) {
    let rowBuf = new Uint8Array(w);
    let colBuf = new Uint8Array(h);
    for (let level=levels; level>0; level--) {
        const ngate = noiseGates[level];
        const gain = gains[level];
        const bias = biases[level];
        const biasBoost = (bias > 0) ? (1 << bias) : 0;
        // cols and rows define the pixel buffer subregion that the current
        // level of the wavelet transform operates on. Level 1 does the whole
        // pixel buffer, level 2 does only the top left quadrant, and so on.
        const cols = w >> (level-1);
        const rows = h >> (level-1);
        // Loop over all the columns (vertical average and difference)
        for (let x=0; x<cols; x+=1) {
            // Transform (average, difference) pairs into (y, y+1) pixel pairs
            for (let y=0; y<rows; y+=2) {
                const pxAvg = (w * (y>>1)) + x;
                const pxDiff = (w * ((rows+y)>>1)) + x;
                let a = luma[pxAvg];                 // average
                let b = luma[pxDiff] << 24 >> 24;    // sign extend diff
                b = Math.abs(b) < ngate ? 0 : b;     // gate noise below cutoff
                // Invert the average and difference
                a = a - b;
                b = (b << 1) + a;
                a = (a >> gain) + biasBoost;
                b = (b >> gain) + biasBoost;
                // Clamp to range 0..255 to avoid quantization noise errors
                a = (a < 0) ? 0 : ((a > 255) ? 255 : a);
                b = (b < 0) ? 0 : ((b > 255) ? 255 : b);
                // Store results in Uint8 buffer
                colBuf[y]   = a & 0xff;
                colBuf[y+1] = b & 0xff;
            }
            // Overwrite input averages and differences with pixels
            for (let y=0; y<rows; y++) {
              luma[(y*w)+x] = colBuf[y];
            }
        }
        // Loop over all the rows (horizontal average and difference)
        for (let y=0; y<rows; y+=1) {
            const rowBase = y * w;
            // Transform (average, difference) pairs into (x, x+1) pixel pairs
            for (let x=0; x<cols; x+=2) {
                const pxAvg = rowBase + (x>>1);
                const pxDiff = rowBase + ((cols+x)>>1);
                let a = luma[pxAvg];                 // average
                let b = luma[pxDiff] << 24 >> 24;    // sign extend diff
                b = Math.abs(b) < ngate ? 0 : b;     // gate noise below cutoff
                // Invert the average and difference
                a = a - b;
                b = (b << 1) + a;
                a = (a >> gain) + biasBoost;
                b = (b >> gain) + biasBoost;
                // Clamp to range 0..255 to avoid quantization noise errors
                a = (a < 0) ? 0 : ((a > 255) ? 255 : a);
                b = (b < 0) ? 0 : ((b > 255) ? 255 : b);
                // Store results in Uint8 buffer
                rowBuf[x]   = a & 0xff;
                rowBuf[x+1] = b & 0xff;
            }
            // Overwrite input averages and differences with pixels
            for (let x=0; x<cols; x++) {
                luma[rowBase+x] = rowBuf[x];
            }
        }
    }
}

// Process video frames
function handleNewFrame(now, metadata) {
    // Copy video frame from video element to canvas element
    const w = VIDEO.videoWidth;
    const h = VIDEO.videoHeight;
    const levels = 6;
    const noiseGates = [
        Number(NGATE1.value),
        Number(NGATE2.value),
        Number(NGATE3.value),
        Number(NGATE4.value),
        Number(NGATE5.value),
        Number(NGATE6.value),
    ];
    const gains = [
        Number(GAIN1.value),
        Number(GAIN2.value),
        Number(GAIN3.value),
        Number(GAIN4.value),
        Number(GAIN5.value),
        Number(GAIN6.value),
    ];
    const biases = [
        Number(BAIS1.value),
        Number(BAIS2.value),
        Number(BAIS3.value),
        Number(BAIS4.value),
        Number(BAIS5.value),
        Number(BAIS6.value),
    ];
    CANVAS.width = w;
    CANVAS.height = h;
    CTX.drawImage(VIDEO, 0, 0, w, h);
    // Apply filter to the pixels of the canvas element
    // getImageData returns RGBA Uint8ClampedArray of pixels in row-major order
    const imageData = CTX.getImageData(0, 0, w, h);
    const rgba = imageData.data;
    var luma = lumaFrom(rgba);
    // -- begin filter chain ---

    waveletFwdHaar(w, h, levels, luma);
    if (INV_WAVE.checked) {
        waveletInvHaar(w, h, levels, luma, noiseGates, gains, biases);
    }
    if (INV_LUMA.checked) {
        invert(luma);
    }

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
