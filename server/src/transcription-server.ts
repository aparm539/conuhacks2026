import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SpeechClient } from '@google-cloud/speech';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { MAX_REQUEST_BODY_SIZE } from './config/constants';
import { createTranscribeRoute } from './routes/transcribe';
import { createBatchLocationRoute } from './routes/location';
import { createProcessSegmentsRoute } from './routes/processSegments';
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

// Initialize clients
let speechClient: SpeechClient | null = null;
let geminiClient: GoogleGenerativeAI | null = null;

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

function initializeGeminiClient(): void {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error('Gemini API key not found in .env file');
    console.error('Please set GEMINI_API_KEY');
    return;
  }

  geminiClient = new GoogleGenerativeAI(apiKey);
  console.log('Gemini client initialized');
}

// Initialize clients
initializeSpeechClient();
initializeGeminiClient();

// Routes
app.post('/transcribe', createTranscribeRoute(speechClient));
app.post('/process-segments', createProcessSegmentsRoute(geminiClient));
app.post('/select-comment-locations', createBatchLocationRoute(geminiClient));

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
  if (!geminiClient) {
    console.warn('WARNING: Gemini client not initialized. Classification requests will fail.');
  }
  console.log('Server is ready to accept requests...');
});
