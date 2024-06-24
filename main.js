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

// Process video frames
function handleNewFrame(now, metadata) {
    // Copy video frame from video element to canvas element
    const w = VIDEO.videoWidth;
    const h = VIDEO.videoHeight;
    CANVAS.width = w;
    CANVAS.height = h;
    CTX.drawImage(VIDEO, 0, 0, w, h);
    // Apply filter to the pixels of the canvas element
    const imageData = CTX.getImageData(0, 0, w, h);  // RGBA, row-major order
    const data = imageData.data;                     // Uint8ClampedArray
    // Convert RGB to approximate Rec. 601 luma (Y')
    // see: https://en.wikipedia.org/wiki/Luma_(video)
    //   Y'[601] = 0.299*R' + 0.587*G' + 0.114*B'
    // The official formula uses floating point coefficients, but the image
    // data is 8-bit unsigned integers. Since an approximation is fine here,
    // we can normalize the coefficients to 1*B' and round them to integers:
    //   Y' = (3*R' + 5*G' + 1*B') / 9
    // The sum of coefficients is 3 + 5 + 1 = 9, which is annoying. If the sum
    // was 8, we could use a shift (>>3). Approximating 5*G' as 4*G', gives:
    //   Y' = (3*R' + 4*G' + B') >> 3
    for (let i=0; i < data.length - 4; i += 4) {
        const Y = ((3 * data[i]) + (4 * data[i+1]) + data[i+2]) >> 3;
        data[i] = data[i+1] = data[i+2] = Y;
    }
    // Invert the brightness (make it look like a B&W negative)
    for (let i=0; i < data.length - 4; i += 4) {
        data[i] = data[i+1] = data[i+2] = 255 - data[i];
    }
    CTX.putImageData(imageData, 0, 0);
    // Schedule a callback for the next frame
    if (HAS_RVFC) {
        VIDEO.requestVideoFrameCallback(handleNewFrame);
    }
}

// Attempt to open video stream from default camera
function startVideo() {
    const constraints = {video: {
        width: 480,
        height: 480,
        facingMode: "environment",
        frameRate: 15,
    }};
    if (! navigator.mediaDevices) {
        console.log("navigator.mediaDevices missing... iOS lockdown mode?");
        alert("It looks like you might be using an iOS device with lockdown "
         + "mode enabled. If so, you will need to grant an exception for this "
         + "page in order to use the camera ('AA' menu in URL bar > Website "
         + "Settings > Lockdown Mode [turn switch off].");
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
