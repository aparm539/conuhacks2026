#!/usr/bin/env node
/**
 * Quick test script for the transcription server
 * Tests the Google Cloud Speech API integration
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const SERVER_URL = 'http://localhost:3000';
const TEST_AUDIO_PATH = process.argv[2]; // Optional: path to test audio file

async function testHealth() {
  console.log('🔍 Testing server health...');
  try {
    const response = await fetch(`${SERVER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    
    // We expect an error, but it means the server is running
    if (response.status === 400 || response.status === 500) {
      console.log('✅ Server is running and responding');
      return true;
    }
  } catch (error) {
    console.error('❌ Server is not running:', error.message);
    console.log('   Make sure to start the transcription server first:');
    console.log('   docker-compose up -d transcription-server');
    return false;
  }
}

async function testTranscription(audioBase64) {
  console.log('\n🎤 Testing transcription...');
  try {
    const response = await fetch(`${SERVER_URL}/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: audioBase64 })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const result = await response.json();
    console.log('✅ Transcription successful!');
    console.log('📝 Transcript:', result.transcript);
    return true;
  } catch (error) {
    console.error('❌ Transcription failed:', error.message);
    
    if (error.message.includes('Speech client not initialized')) {
      console.log('\n💡 Fix: Check your Google Cloud credentials in server/.env');
      console.log('   Required variables:');
      console.log('   - GOOGLE_CLIENT_EMAIL');
      console.log('   - GOOGLE_PRIVATE_KEY');
    }
    
    return false;
  }
}

async function main() {
  console.log('🧪 PR Notes Extension - Transcription Server Test\n');
  
  // Test 1: Health check
  const isHealthy = await testHealth();
  if (!isHealthy) {
    process.exit(1);
  }

  // Test 2: Transcription (if audio file provided)
  if (TEST_AUDIO_PATH) {
    try {
      const audioBuffer = fs.readFileSync(TEST_AUDIO_PATH);
      const audioBase64 = audioBuffer.toString('base64');
      await testTranscription(audioBase64);
    } catch (error) {
      console.error('❌ Failed to read audio file:', error.message);
      process.exit(1);
    }
  } else {
    console.log('\n💡 Tip: Provide an audio file to test transcription:');
    console.log('   node test-server.js path/to/audio.wav');
  }

  console.log('\n✨ Test complete!');
}

// Use fetch polyfill for Node.js < 18
if (typeof fetch === 'undefined') {
  global.fetch = require('node-fetch');
}

main().catch(console.error);
