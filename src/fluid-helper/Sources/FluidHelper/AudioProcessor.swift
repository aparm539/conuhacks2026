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
    private var segmentCount = 0
    private var recordingStartTime: Date?
    
    // Track last known speaker from diarization (used when emitting segments after stop)
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
    
    /// Start recording; audio is accumulated only until stop (then batch diarization + ASR)
    func startRecording(deviceId: String? = nil) async throws {
        // Ensure models are initialized first
        if !isInitialized {
            try await initialize()
        }
        
        // Reset diarizer state so each recording gets fresh speaker labels (Option B session reset)
        diarizer?.speakerManager.reset()
        
        // Reset state for new recording
        sampleBuffer.removeAll()
        collectedSegments.removeAll()
        totalSpeakers = 0
        segmentCount = 0
        recordingStartTime = Date()
        currentSpeakerId = 0
        
        if recorder == nil {
            recorder = AudioRecorder()
        }
        
        // Start recording; callback only accumulates samples (no ASR or diarization during recording)
        try recorder?.startRecording(deviceId: deviceId) { [weak self] samples in
            guard let self = self else { return }
            Task {
                await self.appendRecordingSamples(samples)
            }
        }
    }
    
    /// Accumulate samples during recording (no ASR or diarization until stop)
    private func appendRecordingSamples(_ samples: [Float]) async {
        sampleBuffer.append(contentsOf: samples)
    }
    
    /// Stop recording - run batch diarization and ASR on full buffer, then emit segments and done
    func stopRecording() async {
        recorder?.stopRecording()
        
        let endTime = Date().timeIntervalSince(recordingStartTime ?? Date())
        
        guard !sampleBuffer.isEmpty else {
            emit(DoneMessage(totalSpeakers: 0, totalSegments: 0, totalDuration: endTime))
            recordingStartTime = nil
            return
        }
        
        emit(ProgressMessage(stage: "diarization", message: "Detecting speakers...", percent: nil))
        
        // Batch diarization on full buffer (Option B)
        var diarizationSegments: [(speakerId: Int, start: Double, end: Double)] = []
        if let diarizer = diarizer {
            do {
                let result = try diarizer.performCompleteDiarization(sampleBuffer)
                totalSpeakers = max(totalSpeakers, diarizer.speakerManager.speakerCount)
                for seg in result.segments {
                    let id = extractSpeakerId(from: seg.speakerId)
                    diarizationSegments.append((id, Double(seg.startTimeSeconds), Double(seg.endTimeSeconds)))
                }
            } catch {
                emitDebug("Diarization failed, using single speaker: \(error)")
            }
        }
        
        emit(ProgressMessage(stage: "asr", message: "Transcribing...", percent: nil))
        
        // ASR on full buffer
        var fullText = ""
        if let asrManager = asrManager {
            do {
                let result = try await asrManager.transcribe(sampleBuffer, source: .microphone)
                fullText = result.text.trimmingCharacters(in: .whitespaces)
            } catch {
                emitError("ASR failed: \(error.localizedDescription)")
            }
        }
        
        // Emit segments: one per speaker span (merge consecutive same-speaker diarization segments)
        if diarizationSegments.isEmpty || fullText.isEmpty {
            if !fullText.isEmpty {
                emit(SegmentMessage(speakerId: 0, text: fullText, start: 0, end: endTime, isFinal: true))
                segmentCount = 1
            }
        } else {
            var i = 0
            while i < diarizationSegments.count {
                let speakerId = diarizationSegments[i].speakerId
                let spanStart = diarizationSegments[i].start
                var spanEnd = diarizationSegments[i].end
                while i + 1 < diarizationSegments.count && diarizationSegments[i + 1].speakerId == speakerId {
                    i += 1
                    spanEnd = diarizationSegments[i].end
                }
                emit(SpeakerMessage(id: speakerId, start: spanStart, end: spanEnd))
                emit(SegmentMessage(speakerId: speakerId, text: fullText, start: spanStart, end: spanEnd, isFinal: true))
                segmentCount += 1
                i += 1
            }
        }
        
        emit(DoneMessage(totalSpeakers: totalSpeakers, totalSegments: segmentCount, totalDuration: endTime))
        
        sampleBuffer.removeAll()
        recordingStartTime = nil
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
