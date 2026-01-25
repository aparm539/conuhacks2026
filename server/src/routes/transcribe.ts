import type { Request, Response } from 'express';
import { SpeechClient } from '@google-cloud/speech';
import { transcribeAudio } from '../services/speech';
import { asyncHandler } from '../middleware/errorHandler';

export function createTranscribeRoute(speechClient: SpeechClient | null) {
  return asyncHandler(async (req: Request, res: Response) => {
    console.log('[TRANSCRIBE] Request received at', new Date().toISOString());
    console.log('[TRANSCRIBE] Request body keys:', Object.keys(req.body));
    console.log('[TRANSCRIBE] Audio data length:', req.body.audio ? req.body.audio.length : 'missing');
    
    if (!speechClient) {
      console.error('[TRANSCRIBE] ERROR: Speech client not initialized');
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
    console.log('[TRANSCRIBE] Audio buffer size:', audioBuffer.length, 'bytes');

    try {
      const words = await transcribeAudio(audioBuffer, speechClient);
      console.log('[TRANSCRIBE] Success! Returning', words.length, 'words');
      res.json({ words });
    } catch (error) {
      console.error('[TRANSCRIBE] ERROR:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error('[TRANSCRIBE] Error stack:', error instanceof Error ? error.stack : 'No stack trace');
      
      // Determine appropriate status code based on error type
      let statusCode = 500;
      if (errorMessage.includes('empty') || errorMessage.includes('invalid')) {
        statusCode = 400;
      } else if (errorMessage.includes('No transcription results')) {
        statusCode = 404;
      }
      
      res.status(statusCode).json({ error: `Transcription failed: ${errorMessage}` });
    }
  });
}
