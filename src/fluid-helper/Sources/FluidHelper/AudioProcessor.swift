import Foundation
import FluidAudio
import AVFoundation

/// Processes audio using FluidAudio for ASR and speaker diarization
actor AudioProcessor {
    private var asrManager: AsrManager?
    private var diarizer: DiarizerManager?
    private var audioStream: AudioStream?
    
    private var isInitialized = false
    private var collectedSegments: [SegmentMessage] = []
    private var totalSpeakers = 0
    
    // Audio buffer for accumulating samples
    private var sampleBuffer: [Float] = []
    private let sampleRate: Float = 16000.0
    
    // Recording state
    private var recorder: AudioRecorder?
    private var currentStreamText = ""
    private var lastEmittedEnd: Double = 0
    private var segmentCount = 0
    private var recordingStartTime: Date?
    
    // Streaming ASR buffer - need enough samples for meaningful transcription
    private var streamingAsrBuffer: [Float] = []
    private let minAsrSamples: Int = 24000  // 1.5 seconds at 16kHz - FluidAudio needs this much
    private var lastAsrTime: Double = 0
    private let asrInterval: Double = 1.0  // Run ASR every 1 second
    
    // Pause detection settings
    private let silenceThreshold: Float = 0.01  // RMS below this = silence
    private let pauseDuration: Double = 0.4     // 400ms pause = segment boundary
    private var silenceStartTime: Double?
    private var lastSpeechTime: Double = 0
    
    // Track last known speaker from diarization
    private var currentSpeakerId: Int = 0
    
    /// Initialize FluidAudio models
    func initialize() async throws {
        guard !isInitialized else { return }
        
        // Download and load ASR models (Parakeet v3 for multilingual)
        emit(ProgressMessage(stage: "asr", message: "Downloading ASR model (~600MB)...", percent: nil))
        let asrModels = try await AsrModels.downloadAndLoad(version: .v3)
        emit(ProgressMessage(stage: "asr", message: "Initializing ASR...", percent: 80))
        asrManager = AsrManager(config: .default)
        try await asrManager?.initialize(models: asrModels)
        emit(ProgressMessage(stage: "asr", message: "ASR ready", percent: 100))
        
        // Download and load diarization models
        emit(ProgressMessage(stage: "diarization", message: "Downloading diarization model (~50MB)...", percent: nil))
        let diarizerModels = try await DiarizerModels.downloadIfNeeded()
        emit(ProgressMessage(stage: "diarization", message: "Initializing diarization...", percent: 80))
        diarizer = DiarizerManager()
        diarizer?.initialize(models: diarizerModels)
        emit(ProgressMessage(stage: "diarization", message: "Diarization ready", percent: 100))
        
        // Configure audio stream for chunked diarization
        audioStream = try AudioStream(
            chunkDuration: 5.0,      // Good balance of accuracy and latency
            chunkSkip: 2.0,          // Duration between successive chunk starts
            streamStartTime: 0.0,
            chunkingStrategy: .useMostRecent
        )
        
        // Bind diarization callback
        audioStream?.bind { [weak self] chunk, time in
            guard let self = self else { return }
            Task {
                await self.processDiarizationChunk(chunk, atTime: time)
            }
        }
        
        isInitialized = true
        emit(ReadyMessage(modelsLoaded: true))
    }
    
    /// Process incoming audio data (base64 encoded PCM Int16)
    func processAudio(data: Data, inputSampleRate: Int) async {
        guard isInitialized else {
            emitError("Audio processor not initialized")
            return
        }
        
        // Convert PCM Int16 data to Float32 samples
        let samples = convertPCMToFloat32(data: data)
        
        // Resample if needed (FluidAudio expects 16kHz)
        let resampledSamples: [Float]
        if inputSampleRate != 16000 {
            resampledSamples = resample(samples, from: inputSampleRate, to: 16000)
        } else {
            resampledSamples = samples
        }
        
        // Add to buffer
        sampleBuffer.append(contentsOf: resampledSamples)
        
        // Feed to audio stream for diarization
        do {
            try audioStream?.write(from: resampledSamples)
        } catch {
            emitError("Failed to write to audio stream: \(error.localizedDescription)")
        }
    }
    
    /// Finalize processing and return all segments
    func finalize() async {
        guard isInitialized, !sampleBuffer.isEmpty else {
            emit(DoneMessage(totalSpeakers: 0, totalSegments: 0, totalDuration: 0))
            return
        }
        
        // Run final ASR on accumulated audio
        do {
            if let result = try await asrManager?.transcribe(sampleBuffer, source: .microphone) {
                emit(ConfirmedMessage(text: result.text, confidence: Float(result.confidence)))
                
                // Create final segment with transcription
                // Match transcription to speaker segments
                await matchTranscriptionToSpeakers(text: result.text)
            }
        } catch {
            emitError("ASR transcription failed: \(error.localizedDescription)")
        }
        
        // Emit done message
        let totalDuration = Double(sampleBuffer.count) / Double(sampleRate)
        emit(DoneMessage(totalSpeakers: totalSpeakers, totalSegments: collectedSegments.count, totalDuration: totalDuration))
        
        // Reset state
        sampleBuffer.removeAll()
        collectedSegments.removeAll()
    }
    
    // MARK: - Real-Time Recording
    
    /// Start recording and streaming audio processing
    func startRecording(deviceId: String? = nil) async throws {
        // Ensure models are initialized first
        if !isInitialized {
            try await initialize()
        }
        
        // Reset state for new recording
        sampleBuffer.removeAll()
        streamingAsrBuffer.removeAll()
        collectedSegments.removeAll()
        totalSpeakers = 0
        currentStreamText = ""
        lastEmittedEnd = 0
        segmentCount = 0
        recordingStartTime = Date()
        silenceStartTime = nil
        lastSpeechTime = 0
        lastAsrTime = 0
        currentSpeakerId = 0
        
        if recorder == nil {
            recorder = AudioRecorder()
        }
        
        // Start recording with streaming callback
        try recorder?.startRecording(deviceId: deviceId) { [weak self] samples in
            guard let self = self else { return }
            Task {
                await self.processStreamingChunk(samples)
            }
        }
    }
    
    /// Stop recording - do final transcription if needed
    func stopRecording() async {
        recorder?.stopRecording()
        
        let endTime = Date().timeIntervalSince(recordingStartTime ?? Date())
        
        // Emit any remaining pending text as final segment
        if !currentStreamText.trimmingCharacters(in: .whitespaces).isEmpty {
            emit(SegmentMessage(
                speakerId: currentSpeakerId,
                text: currentStreamText.trimmingCharacters(in: .whitespaces),
                start: lastEmittedEnd,
                end: endTime,
                isFinal: true
            ))
            segmentCount += 1
        }
        
        // If no segments were produced during streaming, do a final transcription
        // of the full accumulated audio buffer
        if segmentCount == 0 && !sampleBuffer.isEmpty {
            let totalSamples = sampleBuffer.count
            let totalDurationSecs = Float(totalSamples) / sampleRate
            emitDebug("No streaming segments produced. Running final ASR on \(totalSamples) samples (\(String(format: "%.2f", totalDurationSecs))s)")
            
            do {
                if let result = try await asrManager?.transcribe(sampleBuffer, source: .microphone) {
                    let text = result.text.trimmingCharacters(in: .whitespaces)
                    emitDebug("Final ASR result: '\(text)' (confidence: \(result.confidence))")
                    if !text.isEmpty {
                        emit(SegmentMessage(
                            speakerId: currentSpeakerId,
                            text: text,
                            start: 0,
                            end: endTime,
                            isFinal: true
                        ))
                        segmentCount += 1
                    }
                } else {
                    emitDebug("ASR manager not available for final transcription")
                }
            } catch {
                emitDebug("Final transcription error: \(error)")
                emitError("Final transcription failed: \(error.localizedDescription)")
            }
        } else {
            emitDebug("Streaming produced \(segmentCount) segments, skipping final ASR")
        }
        
        // Emit summary
        let totalDuration = endTime
        emit(DoneMessage(
            totalSpeakers: totalSpeakers,
            totalSegments: segmentCount,
            totalDuration: totalDuration
        ))
        
        // Reset state
        sampleBuffer.removeAll()
        streamingAsrBuffer.removeAll()
        currentStreamText = ""
        recordingStartTime = nil
    }
    
    /// Process an incoming audio chunk in real-time
    private func processStreamingChunk(_ samples: [Float]) async {
        let chunkTime = Date().timeIntervalSince(recordingStartTime ?? Date())
        
        // Accumulate samples for full recording and streaming ASR
        sampleBuffer.append(contentsOf: samples)
        streamingAsrBuffer.append(contentsOf: samples)
        
        // Feed to audio stream for real-time diarization
        do {
            try audioStream?.write(from: samples)
        } catch {
            // Non-fatal, continue processing
        }
        
        // Check for pause detection first
        let isPause = detectPause(samples: samples, currentTime: chunkTime)
        
        // Only run ASR when we have enough samples
        // Even on pause, we need minimum samples for ASR to work
        let hasEnoughSamples = streamingAsrBuffer.count >= minAsrSamples
        let shouldRunAsr = hasEnoughSamples && (chunkTime - lastAsrTime) >= asrInterval
        let shouldFlushOnPause = isPause && hasEnoughSamples
        
        guard shouldRunAsr || shouldFlushOnPause else { return }
        guard let asrManager = asrManager else {
            emitDebug("ASR manager not available")
            return
        }
        
        // Run ASR on accumulated buffer
        let samplesToProcess = streamingAsrBuffer
        let sampleCount = samplesToProcess.count
        let durationSecs = Float(sampleCount) / sampleRate
        streamingAsrBuffer.removeAll()
        lastAsrTime = chunkTime
        
        emitDebug("Running streaming ASR on \(sampleCount) samples (\(String(format: "%.2f", durationSecs))s)")
        
        do {
            let result = try await asrManager.transcribe(samplesToProcess, source: .microphone)
            let newText = result.text.trimmingCharacters(in: .whitespaces)
            
            emitDebug("ASR result: '\(newText)' (confidence: \(result.confidence))")
            
            // Accumulate text
            if !newText.isEmpty {
                currentStreamText += (currentStreamText.isEmpty ? "" : " ") + newText
            }
            
            // Emit volatile for UI feedback
            if !currentStreamText.isEmpty {
                emit(VolatileMessage(text: currentStreamText))
            }
            
            // If pause detected, emit segment
            if isPause && !currentStreamText.trimmingCharacters(in: .whitespaces).isEmpty {
                emit(SegmentMessage(
                    speakerId: currentSpeakerId,
                    text: currentStreamText.trimmingCharacters(in: .whitespaces),
                    start: lastEmittedEnd,
                    end: chunkTime,
                    isFinal: true
                ))
                
                segmentCount += 1
                lastEmittedEnd = chunkTime
                currentStreamText = ""
                silenceStartTime = nil  // Reset for next segment
            }
        } catch {
            emitDebug("Streaming ASR error: \(error)")
        }
    }
    
    // MARK: - Pause Detection
    
    /// Detect if we're in a pause (silence) that indicates segment boundary
    private func detectPause(samples: [Float], currentTime: Double) -> Bool {
        let rms = calculateRMS(samples)
        
        if rms < silenceThreshold {
            // Currently silent
            if silenceStartTime == nil {
                silenceStartTime = currentTime
            }
            
            // Check if pause is long enough
            if let start = silenceStartTime, (currentTime - start) >= pauseDuration {
                return true
            }
        } else {
            // Speech detected - reset silence timer
            silenceStartTime = nil
            lastSpeechTime = currentTime
        }
        
        return false
    }
    
    /// Calculate RMS (root mean square) energy of audio samples
    private func calculateRMS(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        let sumOfSquares = samples.reduce(0) { $0 + $1 * $1 }
        return sqrt(sumOfSquares / Float(samples.count))
    }
    
    // MARK: - Private Methods
    
    private func processDiarizationChunk(_ chunk: [Float], atTime time: Double) async {
        guard let diarizer = diarizer else { return }
        
        do {
            let result = try diarizer.performCompleteDiarization(chunk, atTime: time)
            
            // Update total speakers
            totalSpeakers = max(totalSpeakers, diarizer.speakerManager.speakerCount)
            
            // Emit speaker segments and update current speaker
            for segment in result.segments {
                let speakerId = extractSpeakerId(from: segment.speakerId)
                
                // Update current speaker for real-time segment attribution
                currentSpeakerId = speakerId
                
                emit(SpeakerMessage(
                    id: speakerId,
                    start: Double(segment.startTimeSeconds),
                    end: Double(segment.endTimeSeconds)
                ))
            }
        } catch {
            emitError("Diarization failed: \(error.localizedDescription)")
        }
    }
    
    private func matchTranscriptionToSpeakers(text: String) async {
        // For now, create a single segment with the full transcription
        // In a more sophisticated implementation, we would align words to speaker segments
        let duration = Double(sampleBuffer.count) / Double(sampleRate)
        
        // Use the most common speaker or speaker 0 as default
        let speakerId = 0
        
        let segment = SegmentMessage(
            speakerId: speakerId,
            text: text,
            start: 0.0,
            end: duration,
            isFinal: true
        )
        
        collectedSegments.append(segment)
        emit(segment)
    }
    
    private func extractSpeakerId(from speakerLabel: String) -> Int {
        // Extract numeric ID from labels like "Speaker_0" or "SPEAKER_01"
        let digits = speakerLabel.filter { $0.isNumber }
        return Int(digits) ?? 0
    }
    
    private func convertPCMToFloat32(data: Data) -> [Float] {
        // PCM Int16 to Float32 conversion
        let int16Count = data.count / 2
        var floatSamples = [Float](repeating: 0, count: int16Count)
        
        data.withUnsafeBytes { rawBuffer in
            let int16Buffer = rawBuffer.bindMemory(to: Int16.self)
            for i in 0..<int16Count {
                floatSamples[i] = Float(int16Buffer[i]) / Float(Int16.max)
            }
        }
        
        return floatSamples
    }
    
    private func resample(_ samples: [Float], from sourceSampleRate: Int, to targetSampleRate: Int) -> [Float] {
        // Simple linear interpolation resampling
        let ratio = Double(sourceSampleRate) / Double(targetSampleRate)
        let newLength = Int(Double(samples.count) / ratio)
        
        var resampled = [Float](repeating: 0, count: newLength)
        
        for i in 0..<newLength {
            let srcIndex = Double(i) * ratio
            let srcIndexInt = Int(srcIndex)
            let fraction = Float(srcIndex - Double(srcIndexInt))
            
            if srcIndexInt + 1 < samples.count {
                resampled[i] = samples[srcIndexInt] * (1 - fraction) + samples[srcIndexInt + 1] * fraction
            } else if srcIndexInt < samples.count {
                resampled[i] = samples[srcIndexInt]
            }
        }
        
        return resampled
    }
}
