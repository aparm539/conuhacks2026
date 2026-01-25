import Foundation
import AVFoundation
import CoreAudio

/// Callback type for streaming audio samples
typealias AudioChunkHandler = ([Float]) -> Void

/// Records audio from a specified input device using AVAudioEngine
/// Streams 16kHz mono Float32 samples in real-time via callback
class AudioRecorder {
    private let engine = AVAudioEngine()
    private var isRecording = false
    private let targetSampleRate: Double = 16000
    
    /// Callback invoked for each audio chunk (called on audio thread)
    var onAudioChunk: AudioChunkHandler?
    
    /// List available audio input devices
    static func listInputDevices() -> [(id: String, name: String)] {
        var devices: [(id: String, name: String)] = []
        
        var propertyAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        var dataSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize
        ) == noErr else { return devices }
        
        let deviceCount = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
        
        guard AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &propertyAddress,
            0, nil,
            &dataSize,
            &deviceIDs
        ) == noErr else { return devices }
        
        for deviceID in deviceIDs {
            // Check if device has input channels
            var inputAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var bufferListSize: UInt32 = 0
            guard AudioObjectGetPropertyDataSize(deviceID, &inputAddress, 0, nil, &bufferListSize) == noErr else { continue }
            
            let bufferList = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: Int(bufferListSize))
            defer { bufferList.deallocate() }
            
            guard AudioObjectGetPropertyData(deviceID, &inputAddress, 0, nil, &bufferListSize, bufferList) == noErr else { continue }
            
            let inputChannels = (0..<Int(bufferList.pointee.mNumberBuffers)).reduce(0) { total, i in
                total + Int(bufferList.pointee.mBuffers.mNumberChannels)
            }
            
            guard inputChannels > 0 else { continue }
            
            // Get device name
            var nameAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceNameCFString,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            
            var name: CFString = "" as CFString
            var nameSize = UInt32(MemoryLayout<CFString>.size)
            
            if AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &name) == noErr {
                devices.append((id: String(deviceID), name: name as String))
            }
        }
        
        return devices
    }
    
    /// Set the input device by device ID
    private func setInputDevice(_ deviceId: String?) throws {
        guard let deviceIdString = deviceId,
              let deviceIdInt = UInt32(deviceIdString) else {
            // Use default device
            return
        }
        
        let deviceID = AudioDeviceID(deviceIdInt)
        let audioUnit = engine.inputNode.audioUnit!
        var inputDeviceID = deviceID
        
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &inputDeviceID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        
        if status != noErr {
            throw RecordingError.deviceError("Failed to set input device: \(status)")
        }
    }
    
    /// Start recording and streaming audio chunks
    /// - Parameters:
    ///   - deviceId: The device ID string, or nil for default
    ///   - chunkHandler: Callback invoked with each audio chunk (16kHz mono Float32)
    func startRecording(deviceId: String? = nil, chunkHandler: @escaping AudioChunkHandler) throws {
        guard !isRecording else { return }
        
        self.onAudioChunk = chunkHandler
        
        // Set input device if specified
        try setInputDevice(deviceId)
        
        let inputNode = engine.inputNode
        let inputFormat = inputNode.outputFormat(forBus: 0)
        
        // Create converter format (16kHz mono)
        guard let outputFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: false
        ) else {
            throw RecordingError.formatError
        }
        
        // Create sample rate converter if needed
        let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        
        // Install tap - streams audio in real-time
        inputNode.installTap(onBus: 0, bufferSize: 1600, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self, let handler = self.onAudioChunk else { return }
            
            var samples: [Float] = []
            
            if let converter = converter {
                // Convert to 16kHz mono
                let frameCount = AVAudioFrameCount(
                    Double(buffer.frameLength) * self.targetSampleRate / inputFormat.sampleRate
                )
                guard let convertedBuffer = AVAudioPCMBuffer(
                    pcmFormat: outputFormat,
                    frameCapacity: frameCount
                ) else { return }
                
                var error: NSError?
                converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                    outStatus.pointee = .haveData
                    return buffer
                }
                
                if error == nil, let channelData = convertedBuffer.floatChannelData?[0] {
                    samples = Array(UnsafeBufferPointer(
                        start: channelData,
                        count: Int(convertedBuffer.frameLength)
                    ))
                }
            } else {
                // Already correct format
                if let channelData = buffer.floatChannelData?[0] {
                    samples = Array(UnsafeBufferPointer(
                        start: channelData,
                        count: Int(buffer.frameLength)
                    ))
                }
            }
            
            // Stream chunk to handler immediately
            if !samples.isEmpty {
                handler(samples)
            }
        }
        
        try engine.start()
        isRecording = true
        emit(RecordingStatusMessage(status: "started"))
    }
    
    /// Stop recording
    func stopRecording() {
        guard isRecording else { return }
        
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        isRecording = false
        onAudioChunk = nil
        
        emit(RecordingStatusMessage(status: "stopped"))
    }
    
    enum RecordingError: Error {
        case formatError
        case deviceError(String)
        case engineError(String)
    }
}
