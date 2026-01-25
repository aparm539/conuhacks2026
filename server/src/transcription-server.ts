import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SpeechClient } from '@google-cloud/speech';
import { MAX_REQUEST_BODY_SIZE } from './config/constants';
import { createTranscribeRoute } from './routes/transcribe';
import { createClassifyRoute } from './routes/classify';
import { createTransformRoute } from './routes/transform';
import { createSplitRoute } from './routes/split';
import { createLocationRoute, createBatchLocationRoute } from './routes/location';
import { errorHandler } from './middleware/errorHandler';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: MAX_REQUEST_BODY_SIZE }));

// Request logging middleware
app.use((req: Request, res: Response, next: () => void) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// Initialize clients (Gemini key is supplied per-request by the extension; no env key used)
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

  console.log('Google Cloud Speech client initialized. big things are in the console.');
}

initializeSpeechClient();

// Health check endpoint
app.get('/health', (req: Request, res: Response) => {
  console.log('[HEALTH] Health check requested');
  res.json({
    status: 'healthy',
    service: 'transcription-server',
    timestamp: new Date().toISOString(),
    speechClientInitialized: speechClient !== null,
    geminiSupported: true,
  });
});

// Routes
app.post('/transcribe', createTranscribeRoute(speechClient));
app.post('/classify', createClassifyRoute());
app.post('/transform', createTransformRoute());
app.post('/split', createSplitRoute());
app.post('/select-comment-location', createLocationRoute());
app.post('/select-comment-locations', createBatchLocationRoute());

// Error handling middleware (must be last)
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`Transcription server running on port ${PORT}`);
  console.log(`Server started at: ${new Date().toISOString()}`);
  console.log(`========================================`);
  if (!speechClient) {
    console.warn('WARNING: Speech client not initialized. Transcription requests will fail.');
  }
  console.log('Gemini: API key must be sent per-request via X-Gemini-Api-Key (from extension).');
  console.log('Server is ready to accept requests...');
});
