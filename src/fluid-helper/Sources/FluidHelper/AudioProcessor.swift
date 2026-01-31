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
    private var lastEmittedEnd: Double = 0
    private var segmentCount = 0
    private var recordingStartTime: Date?
    
    // Batching: accumulate 15 seconds of audio before running ASR
    private var batchBuffer: [Float] = []
    private let batchDurationSeconds: Double = 15.0
    private let batchSamples: Int = 240_000  // 15 * 16000 at 16kHz
    private let minAsrSamples: Int = 24000    // Minimum for ASR (1.5s) - used for partial batch on stop
    
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
        batchBuffer.removeAll()
        collectedSegments.removeAll()
        totalSpeakers = 0
        lastEmittedEnd = 0
        segmentCount = 0
        recordingStartTime = Date()
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
    
    /// Stop recording - process any remaining partial batch, then emit done
    func stopRecording() async {
        recorder?.stopRecording()
        
        let endTime = Date().timeIntervalSince(recordingStartTime ?? Date())
        
        // Process remaining partial batch (whatever is left in batchBuffer)
        if !batchBuffer.isEmpty && batchBuffer.count >= minAsrSamples, let asrManager = asrManager {
            let samplesToProcess = batchBuffer
            let durationSecs = Double(samplesToProcess.count) / Double(sampleRate)
            emitDebug("Processing partial batch on stop: \(samplesToProcess.count) samples (\(String(format: "%.2f", durationSecs))s)")
            
            do {
                let result = try await asrManager.transcribe(samplesToProcess, source: .microphone)
                let text = result.text.trimmingCharacters(in: .whitespaces)
                emitDebug("Partial batch ASR result: '\(text)' (confidence: \(result.confidence))")
                if !text.isEmpty {
                    emit(SegmentMessage(
                        speakerId: currentSpeakerId,
                        text: text,
                        start: lastEmittedEnd,
                        end: endTime,
                        isFinal: true
                    ))
                    segmentCount += 1
                }
            } catch {
                emitDebug("Partial batch ASR error: \(error)")
            }
        }
        
        // Emit summary
        emit(DoneMessage(
            totalSpeakers: totalSpeakers,
            totalSegments: segmentCount,
            totalDuration: endTime
        ))
        
        // Reset state
        sampleBuffer.removeAll()
        batchBuffer.removeAll()
        recordingStartTime = nil
    }
    
    /// Process an incoming audio chunk: accumulate in batch buffer; run ASR every 15 seconds
    private func processStreamingChunk(_ samples: [Float]) async {
        // Accumulate for full recording and for batching
        sampleBuffer.append(contentsOf: samples)
        batchBuffer.append(contentsOf: samples)
        
        // Feed to audio stream for real-time diarization (speaker updates)
        do {
            try audioStream?.write(from: samples)
        } catch {
            // Non-fatal, continue processing
        }
        
        // Run ASR when we have a full 15-second batch
        guard batchBuffer.count >= batchSamples, let asrManager = asrManager else { return }
        
        let batchStart = lastEmittedEnd
        let batchEnd = batchStart + batchDurationSeconds
        
        // Take exactly one batch worth of samples
        let samplesToProcess = Array(batchBuffer.prefix(batchSamples))
        batchBuffer.removeFirst(batchSamples)
        
        emitDebug("Running batch ASR on \(samplesToProcess.count) samples (\(batchDurationSeconds)s)")
        
        do {
            let result = try await asrManager.transcribe(samplesToProcess, source: .microphone)
            let text = result.text.trimmingCharacters(in: .whitespaces)
            
            emitDebug("Batch ASR result: '\(text)' (confidence: \(result.confidence))")
            
            if !text.isEmpty {
                emit(SegmentMessage(
                    speakerId: currentSpeakerId,
                    text: text,
                    start: batchStart,
                    end: batchEnd,
                    isFinal: true
                ))
                segmentCount += 1
                lastEmittedEnd = batchEnd
                emit(VolatileMessage(text: text))
            }
        } catch {
            emitDebug("Batch ASR error: \(error)")
        }
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
