const AudioRecorder = require('node-audiorecorder');

let recorder: any = null;
let stream: any = null;
const chunks: any[] = [];

function startRecording() {
    if (recorder) {
        console.log("Already recording");
        return;
    }
    // TODO: prevent recording from starting if there is audio that has not been saved to file
    console.log("Starting recording");
    recorder = new AudioRecorder({ program: 'sox', silence: 0 }, console);
    chunks.length = 0; 
    
    stream = recorder.start().stream();

    stream.on('data', (chunk: any) => {
        console.log("data is being picked up in server");
        chunks.push(chunk);
    });

    // Listen on the STREAM, not the recorder
    // If you listen on the recorder, it will never pick up the end event. 
    stream.on('end', () => {
        console.log("Stream ended, sending data");
        const audioBuffer = Buffer.concat(chunks);
        process.send?.({ type: 'audio', data: audioBuffer.toString('base64') });
        
        
        recorder = null;
        stream = null;
        chunks.length = 0;
    });

    stream.on('error', (err: any) => {
        console.error("Stream error:", err);
        recorder = null;
        stream = null;
        chunks.length = 0;
    });
}

function stopRecording() {
    if (!recorder) {
        console.log("Not recording");
        return;
    }

    console.log("Stopping recorder");
    recorder.stop();
}

// Listen for messages from parent
process.on('message', (msg: { command: string }) => {
    if (msg.command === 'start') {
        startRecording();
    } else if (msg.command === 'stop') {
        stopRecording();
    }
});
// keeps the process from exiting
process.stdin.resume();