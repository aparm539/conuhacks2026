"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const speech_1 = require("@google-cloud/speech");
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 3000;
app.use((0, cors_1.default)());
app.use(express_1.default.json({ limit: '10mb' }));
let speechClient = null;
function initializeSpeechClient() {
    const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
    const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
    if (!clientEmail || !privateKey) {
        console.error('Google Cloud credentials not found in .env file');
        console.error('Please set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY');
        return;
    }
    speechClient = new speech_1.SpeechClient({
        credentials: {
            client_email: clientEmail,
            private_key: privateKey,
        },
    });
    console.log('Google Cloud Speech client initialized. big things are in the console.');
}
initializeSpeechClient();
app.post('/transcribe', async (req, res) => {
    try {
        if (!speechClient) {
            return res.status(500).json({
                error: 'Speech client not initialized. Check server logs for credential errors.'
            });
        }
        const { audio } = req.body;
        if (!audio || typeof audio !== 'string') {
            return res.status(400).json({
                error: 'Missing or invalid audio data. Expected base64 encoded audio string.'
            });
        }
        // Convert base64 string to Buffer
        const audioBuffer = Buffer.from(audio, 'base64');
        const diarizationConfig = {
            enableSpeakerDiarization: true,
            minSpeakerCount: 1,
            maxSpeakerCount: 10,
        };
        const config = {
            encoding: 'LINEAR16',
            sampleRateHertz: 16000,
            languageCode: 'en-US',
            diarizationConfig: diarizationConfig,
            enableWordTimeOffsets: true,
        };
        const audioConfig = {
            content: audioBuffer,
        };
        const request = {
            config: config,
            audio: audioConfig,
        };
        const [response] = await speechClient.recognize(request);
        if (!response.results || response.results.length === 0) {
            return res.status(404).json({
                error: 'No transcription results returned from Google Cloud Speech API'
            });
        }
        // Extract words from the last result (speaker tags only appear in the final result)
        const lastResult = response.results[response.results.length - 1];
        const alternative = lastResult.alternatives?.[0];
        if (!alternative || !alternative.words) {
            return res.status(404).json({
                error: 'No words found in transcription results'
            });
        }
        // Helper function to format Duration to string (e.g., "1.100s")
        const formatDuration = (duration) => {
            if (!duration)
                return '0s';
            const seconds = duration.seconds || 0;
            const nanos = duration.nanos || 0;
            const totalSeconds = Number(seconds) + (nanos / 1000000000);
            // Format with up to 3 decimal places if needed
            if (totalSeconds === Math.floor(totalSeconds)) {
                return `${totalSeconds}s`;
            }
            return `${totalSeconds.toFixed(3)}s`;
        };
        // Map words to include speaker tags and timestamps
        const words = alternative.words.map((wordInfo) => ({
            word: wordInfo.word || '',
            speakerTag: wordInfo.speakerTag || 0,
            startOffset: formatDuration(wordInfo.startTime),
            endOffset: formatDuration(wordInfo.endTime),
        }));
        res.json({ words });
    }
    catch (error) {
        console.error('Transcription error:', error);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        res.status(500).json({ error: `Transcription failed: ${errorMessage}` });
    }
});
app.listen(PORT, () => {
    console.log(`Transcription server running on port ${PORT}`);
    if (!speechClient) {
        console.warn('WARNING: Speech client not initialized. Transcription requests will fail.');
    }
});
//# sourceMappingURL=transcription-server.js.map