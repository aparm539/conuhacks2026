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
            emit(DoneMessage(totalSpeakers: 0, segments: []))
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
        
        // Emit done message with all collected segments
        let segmentData = collectedSegments.map { seg in
            DoneMessage.SegmentData(
                speakerId: seg.speakerId,
                text: seg.text,
                start: seg.start,
                end: seg.end
            )
        }
        
        emit(DoneMessage(totalSpeakers: totalSpeakers, segments: segmentData))
        
        // Reset state
        sampleBuffer.removeAll()
        collectedSegments.removeAll()
    }
    
    // MARK: - Private Methods
    
    private func processDiarizationChunk(_ chunk: [Float], atTime time: Double) async {
        guard let diarizer = diarizer else { return }
        
        do {
            let result = try diarizer.performCompleteDiarization(chunk, atTime: time)
            
            // Update total speakers
            totalSpeakers = max(totalSpeakers, diarizer.speakerManager.speakerCount)
            
            // Emit speaker segments
            for segment in result.segments {
                let speakerId = extractSpeakerId(from: segment.speakerId)
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
            end: duration
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
