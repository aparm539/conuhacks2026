import Foundation

// MARK: - Input Messages (extension -> helper)

enum InputMessage: Decodable {
    case initialize
    case audio(data: Data, sampleRate: Int)
    case end
    
    enum CodingKeys: String, CodingKey {
        case type
        case data
        case sampleRate
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        
        switch type {
        case "init":
            self = .initialize
        case "audio":
            let base64Data = try container.decode(String.self, forKey: .data)
            guard let data = Data(base64Encoded: base64Data) else {
                throw DecodingError.dataCorruptedError(forKey: .data, in: container, debugDescription: "Invalid base64 data")
            }
            let sampleRate = try container.decodeIfPresent(Int.self, forKey: .sampleRate) ?? 16000
            self = .audio(data: data, sampleRate: sampleRate)
        case "end":
            self = .end
        default:
            throw DecodingError.dataCorruptedError(forKey: .type, in: container, debugDescription: "Unknown message type: \(type)")
        }
    }
}

// MARK: - Output Messages (helper -> extension)

struct ReadyMessage: Encodable {
    let type = "ready"
    let modelsLoaded: Bool
}

struct ProgressMessage: Encodable {
    let type = "progress"
    let stage: String   // "asr" or "diarization"
    let message: String
    let percent: Int?   // 0-100, nil if indeterminate
}

struct VolatileMessage: Encodable {
    let type = "volatile"
    let text: String
}

struct ConfirmedMessage: Encodable {
    let type = "confirmed"
    let text: String
    let confidence: Float
}

struct SpeakerMessage: Encodable {
    let type = "speaker"
    let id: Int
    let start: Double
    let end: Double
}

struct SegmentMessage: Encodable {
    let type = "segment"
    let speakerId: Int
    let text: String
    let start: Double
    let end: Double
}

struct DoneMessage: Encodable {
    let type = "done"
    let totalSpeakers: Int
    let segments: [SegmentData]
    
    struct SegmentData: Encodable {
        let speakerId: Int
        let text: String
        let start: Double
        let end: Double
    }
}

struct ErrorMessage: Encodable {
    let type = "error"
    let message: String
}

// MARK: - Output Helper

func emit<T: Encodable>(_ message: T) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = []  // Compact output (no pretty printing)
    
    do {
        let data = try encoder.encode(message)
        if let jsonString = String(data: data, encoding: .utf8) {
            print(jsonString)
            fflush(stdout)
        }
    } catch {
        // If we can't encode the message, emit an error
        let errorJson = "{\"type\":\"error\",\"message\":\"Failed to encode message: \(error.localizedDescription)\"}"
        print(errorJson)
        fflush(stdout)
    }
}

func emitError(_ message: String) {
    emit(ErrorMessage(message: message))
}
