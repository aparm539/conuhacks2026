import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SpeechClient } from '@google-cloud/speech';
import type { protos } from '@google-cloud/speech';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;


app.use(cors());
app.use(express.json({ limit: '10mb' }));

let speechClient: SpeechClient | null = null;

function initializeSpeechClient(): void {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');

  if (!clientEmail || !privateKey) {
    console.error('Google Cloud credentials not found in .env file');
    console.error('Please set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY');
    return;
  }

  speechClient = new SpeechClient({
    credentials: {
      client_email: clientEmail,
      private_key: privateKey,
    },
  });

  console.log('Google Cloud Speech client initialized');
}

initializeSpeechClient();

app.post('/transcribe', async (req: Request, res: Response) => {
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

    const config: protos.google.cloud.speech.v1.IRecognitionConfig = {
      encoding: 'LINEAR16',
      sampleRateHertz: 16000,
      languageCode: 'en-US',
    };

    const audioConfig: protos.google.cloud.speech.v1.IRecognitionAudio = {
      content: audioBuffer,
    };

    const request: protos.google.cloud.speech.v1.IRecognizeRequest = {
      config: config,
      audio: audioConfig,
    };

    const [response] = await speechClient.recognize(request);

    if (!response.results || response.results.length === 0) {
      return res.status(404).json({ 
        error: 'No transcription results returned from Google Cloud Speech API' 
      });
    }

    // Extract transcript from results
    const transcript = response.results
      .map((result: protos.google.cloud.speech.v1.ISpeechRecognitionResult) => 
        result.alternatives?.[0]?.transcript || ''
      )
      .join(' ');

    res.json({ transcript });
  } catch (error) {
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
