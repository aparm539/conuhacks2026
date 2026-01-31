import Foundation

/// fluid-helper: A command-line tool for real-time audio transcription and speaker diarization
/// using FluidAudio. Communicates via stdin/stdout with newline-delimited JSON.

func processLine(_ line: String, processor: AudioProcessor) async {
    guard !line.isEmpty else { return }
    
    do {
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        let message = try decoder.decode(InputMessage.self, from: data)
        
        switch message {
        case .initialize:
            do {
                try await processor.initialize()
            } catch {
                emitError("Failed to initialize: \(error.localizedDescription)")
            }
            
        case .audio(let audioData, let sampleRate):
            await processor.processAudio(data: audioData, inputSampleRate: sampleRate)
            
        case .end:
            await processor.finalize()
            
        case .startRecording(let deviceId):
            do {
                try await processor.startRecording(deviceId: deviceId)
            } catch {
                emitError("Failed to start recording: \(error.localizedDescription)")
            }
            
        case .stopRecording:
            await processor.stopRecording()
            
        case .listDevices:
            let devices = AudioRecorder.listInputDevices()
            let deviceInfos = devices.map { DevicesMessage.DeviceInfo(id: $0.id, name: $0.name) }
            emit(DevicesMessage(devices: deviceInfos))
        }
    } catch {
        emitError("Failed to parse input: \(error.localizedDescription)")
    }
}

// Main entry point
let processor = AudioProcessor()

// Run async main loop
let semaphore = DispatchSemaphore(value: 0)
Task {
    while let line = readLine() {
        await processLine(line, processor: processor)
    }
    semaphore.signal()
}
semaphore.wait()
