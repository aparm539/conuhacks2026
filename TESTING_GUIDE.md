# Testing Guide for PR Notes Extension

## Overview

The PR Notes extension allows you to create GitHub PR review comments using your voice. It uses **Google Cloud Speech API** (not Gemini API) for transcription.

## Architecture

### Components

1. **VS Code Extension** (`src/extension.ts`)
   - Records audio from your microphone
   - Sends audio to transcription server
   - Displays transcripts as comments in VS Code

2. **Transcription Server** (`server/src/transcription-server.ts`)
   - Express server running on port 3000
   - Uses Google Cloud Speech API for transcription
   - Receives base64-encoded audio and returns transcripts

3. **Diarization Service** (`docker/app.py`) - Optional
   - FastAPI service for speaker diarization
   - Uses pyannote-audio to identify different speakers
   - Runs on port 8000

## Setup Instructions

### 1. Install Dependencies

```bash
# Install extension dependencies
pnpm install

# Install transcription server dependencies
cd server
npm install
cd ..
```

### 2. Set Up Google Cloud Speech API Credentials

The extension uses **Google Cloud Speech API** (not Gemini API). You need:

1. **Create a Google Cloud Project** (if you don't have one)
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Create a new project or select an existing one

2. **Enable Speech-to-Text API**
   - Navigate to "APIs & Services" > "Library"
   - Search for "Cloud Speech-to-Text API"
   - Click "Enable"

3. **Create Service Account**
   - Go to "IAM & Admin" > "Service Accounts"
   - Click "Create Service Account"
   - Give it a name (e.g., "speech-api-service")
   - Grant it the "Cloud Speech-to-Text API User" role
   - Click "Done"

4. **Create and Download JSON Key**
   - Click on the service account you just created
   - Go to "Keys" tab
   - Click "Add Key" > "Create new key"
   - Choose "JSON" format
   - Download the JSON file

5. **Set Up Environment Variables**
   - Create `server/.env` file:
   ```bash
   GOOGLE_CLIENT_EMAIL=your-service-account-email@project-id.iam.gserviceaccount.com
   GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nYour private key here\n-----END PRIVATE KEY-----\n"
   PORT=3000
   ```
   
   **Important**: The `GOOGLE_PRIVATE_KEY` should include the full private key with `\n` characters preserved. You can extract these values from the downloaded JSON file.

### 3. Build the Extension

```bash
# Compile TypeScript
pnpm run compile
```

### 4. Start the Transcription Server

#### Option A: Using Docker (Recommended)

```bash
# Build and start the transcription server
docker-compose up -d transcription-server

# View logs
docker-compose logs -f transcription-server
```

#### Option B: Run Locally

```bash
cd server
npm run build
npm start
# Server will run on http://localhost:3000
```

### 5. Test the Extension

#### Method 1: Run Extension in Development Mode

1. **Open VS Code** in this project directory
2. **Press F5** or go to "Run" > "Start Debugging"
   - This opens a new VS Code window with the extension loaded
3. **In the new window:**
   - Open any file (to have an active editor)
   - Click the microphone icon in the status bar (bottom right)
   - Select "Start Recording"
   - Speak into your microphone
   - Click "Stop Recording"
   - The transcript should appear as a comment in the editor

#### Method 2: Test Transcription Server Directly

You can test the transcription server independently:

```bash
# Test with curl (replace with actual base64 audio)
curl -X POST http://localhost:3000/transcribe \
  -H "Content-Type: application/json" \
  -d '{"audio": "base64-encoded-audio-data"}'
```

#### Method 3: Check Server Health

```bash
# Check if transcription server is running
curl http://localhost:3000/transcribe
# Should return an error about missing audio (which means server is up)
```

## Testing Checklist

- [ ] Extension compiles without errors (`pnpm run compile`)
- [ ] Transcription server starts successfully
- [ ] Google Cloud credentials are configured correctly
- [ ] Extension appears in VS Code status bar
- [ ] Can start recording (microphone icon)
- [ ] Can stop recording
- [ ] Audio is transcribed and appears as a comment
- [ ] Transcript is saved to file in extension storage

## Troubleshooting

### "Failed to connect to transcription server"
- Ensure the transcription server is running on port 3000
- Check `docker-compose ps` or `lsof -i :3000` to verify port is in use
- Check server logs: `docker-compose logs transcription-server`

### "Speech client not initialized"
- Verify `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY` are set in `server/.env`
- Check that the private key includes newlines (`\n`) properly escaped
- Verify the service account has Speech-to-Text API permissions

### "No active editor found"
- Open a file in VS Code before recording
- The extension needs an active editor to create comments

### Recording doesn't work
- Check microphone permissions in system settings
- Verify audio input device is selected in extension settings
- Check VS Code Developer Console for errors (Help > Toggle Developer Tools)

## API Configuration

The extension uses these configuration settings (in VS Code settings.json):

```json
{
  "pr-notes.apiUrl": "http://localhost:8000",  // For diarization service
  "pr-notes.timeout": 300000,                  // 5 minutes
  "pr-notes.inputDevice": "default"            // Audio input device
}
```

## Note: Google Cloud Speech API vs Gemini API

This extension currently uses **Google Cloud Speech-to-Text API**, not Gemini API. If you want to switch to Gemini API for transcription, you would need to:

1. Modify `server/src/transcription-server.ts` to use Gemini API instead
2. Update the API client to use Gemini's speech recognition endpoints
3. Update environment variables accordingly

The current implementation uses the `@google-cloud/speech` package which is specifically for Speech-to-Text API.
