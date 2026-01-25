"""
FastAPI service for speaker diarization using pyannote-audio.
Receives audio files from VS Code extension and returns speaker segments.
"""
import os
# Ensure HuggingFace uses the baked-in model cache from Docker image
# This must be set before importing pyannote.audio or huggingface_hub
os.environ.setdefault("HF_HOME", "/app/.cache/huggingface")
os.environ.setdefault("HF_HUB_CACHE", "/app/.cache/huggingface")

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from typing import List, Optional
import tempfile
import logging

# Patch torch.load to work with pyannote-audio and PyTorch 2.9.0
import torch
_original_torch_load = torch.load
def _patched_torch_load(*args, **kwargs):
    # Always set weights_only=False for pyannote-audio compatibility with PyTorch 2.9.0
    kwargs['weights_only'] = False
    return _original_torch_load(*args, **kwargs)
torch.load = _patched_torch_load

from pyannote.audio import Pipeline

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Developer tunable: pyannote clustering threshold (higher = fewer merges, more speakers).
# Set to None to use pipeline default (~0.71). Try 0.75–0.80 if two speakers merge into one.
CLUSTERING_THRESHOLD: Optional[float] = 0.80

# Developer tunable: segmentation (speech-boundary) parameters. Set to None for pipeline default.
SEG_MIN_DURATION_ON: Optional[float] = 0.0   # seconds; lower = keep short speaker turns
SEG_MIN_DURATION_OFF: Optional[float] = 0.0  # seconds; lower = preserve gaps between speakers
SEG_THRESHOLD: Optional[float] = None        # segmentation confidence
SEG_ONSET: Optional[float] = 0.1             # threshold for speech start (0–1)
SEG_OFFSET: Optional[float] = 0.1           # threshold for speech end (0–1)

app = FastAPI(
    title="Speaker Diarization API",
    description="API for processing audio files with pyannote-audio",
    version="1.0.0"
)

# Initialize pipeline on startup
pipeline: Optional[Pipeline] = None

@app.on_event("startup")
async def load_pipeline():
    """Load the pyannote-audio pipeline on startup."""
    global pipeline
    try:
        logger.info("Loading pyannote-audio pipeline...")
        hf_token = os.getenv("HF_TOKEN")
        if hf_token:
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-community-1",
                token=hf_token
            )
        else:
            logger.warning("HF_TOKEN not set, attempting to load without token (may fail if model requires authentication)")
            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-community-1"
            )
        logger.info("Pipeline loaded successfully!")
        any_tunable = (
            CLUSTERING_THRESHOLD is not None
            or SEG_MIN_DURATION_ON is not None
            or SEG_MIN_DURATION_OFF is not None
            or SEG_THRESHOLD is not None
            or SEG_ONSET is not None
            or SEG_OFFSET is not None
        )
        if any_tunable:
            hparams = pipeline.parameters(instantiated=True)
            if CLUSTERING_THRESHOLD is not None and "clustering" in hparams and "threshold" in hparams["clustering"]:
                hparams["clustering"]["threshold"] = CLUSTERING_THRESHOLD
                logger.info(f"Clustering threshold set to {CLUSTERING_THRESHOLD}")
            seg = hparams.get("segmentation")
            if isinstance(seg, dict):
                for const, key in [
                    (SEG_MIN_DURATION_ON, "min_duration_on"),
                    (SEG_MIN_DURATION_OFF, "min_duration_off"),
                    (SEG_THRESHOLD, "threshold"),
                    (SEG_ONSET, "onset"),
                    (SEG_OFFSET, "offset"),
                ]:
                    if const is not None and key in seg:
                        seg[key] = const
                        logger.info(f"Segmentation {key} set to {const}")
            pipeline.instantiate(hparams)
    except Exception as e:
        logger.error(f"Failed to load pipeline: {e}")
        raise

# Response models
class SpeakerSegment(BaseModel):
    speaker: str
    start: float
    end: float
    duration: float

class DiarizationResponse(BaseModel):
    success: bool
    segments: List[SpeakerSegment]
    total_speakers: int
    total_duration: float
    message: Optional[str] = None

class ErrorResponse(BaseModel):
    success: bool
    error: str
    message: Optional[str] = None

@app.get("/health")
async def health_check():
    """Health check endpoint."""
    return {
        "status": "healthy",
        "service": "pyannote-audio",
        "pipeline_loaded": pipeline is not None
    }

@app.post("/process", response_model=DiarizationResponse)
async def process_audio(audio: UploadFile = File(...)):
    """
    Process an audio file for speaker diarization.
    
    Accepts audio files in various formats (WAV, MP3, etc.).
    Returns speaker segments with timestamps.
    """
    if pipeline is None:
        raise HTTPException(
            status_code=503,
            detail="Pipeline not loaded. Please check server logs."
        )
    
    # Validate file type
    content_type = audio.content_type
    # Common audio file extensions
    audio_extensions = {'.wav', '.mp3', '.m4a', '.flac', '.ogg', '.aac', '.wma', '.opus', '.mp4', '.m4v'}
    
    # Check content type first
    is_audio_content_type = content_type and content_type.startswith('audio/')
    
    # If content type is generic or missing, check file extension
    if not is_audio_content_type:
        if content_type in (None, 'application/octet-stream'):
            # Fall back to checking file extension
            filename = audio.filename or ""
            file_ext = os.path.splitext(filename)[1].lower()
            if file_ext not in audio_extensions:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid file type: {content_type or 'unknown'}. Expected audio file (supported extensions: {', '.join(sorted(audio_extensions))})."
                )
        else:
            # Content type is explicitly non-audio
            raise HTTPException(
                status_code=400,
                detail=f"Invalid file type: {content_type}. Expected audio file."
            )
    
    # Create temporary file for audio
    temp_file = None
    try:
        # Save uploaded file to temporary location
        suffix = os.path.splitext(audio.filename or "audio")[1] or ".wav"
        with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp_file:
            temp_file = tmp_file.name
            # Read and write file content
            content = await audio.read()
            tmp_file.write(content)
        
        logger.info(f"Processing audio file: {audio.filename} ({len(content)} bytes)")
        
        # Process audio with pyannote-audio
        diarization = pipeline(temp_file, num_speakers = 2, min_speakers = 2, max_speakers=2)
        
        # Extract segments
        segments = []
        speakers = set()
        total_duration = 0.0
        
        for turn, speaker in diarization.speaker_diarization:
            start = float(turn.start)
            end = float(turn.end)
            duration = end - start
            
            segments.append({
                "speaker": speaker,
                "start": start,
                "end": end,
                "duration": duration
            })
            
            speakers.add(speaker)
            total_duration = max(total_duration, end)
        
        logger.info(f"Processed {len(segments)} segments from {len(speakers)} speakers")
        
        return DiarizationResponse(
            success=True,
            segments=[SpeakerSegment(**seg) for seg in segments],
            total_speakers=len(speakers),
            total_duration=total_duration,
            message=f"Successfully processed {len(segments)} segments"
        )
        
    except Exception as e:
        logger.error(f"Error processing audio: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error processing audio: {str(e)}"
        )
    finally:
        # Clean up temporary file
        if temp_file and os.path.exists(temp_file):
            try:
                os.remove(temp_file)
            except Exception as e:
                logger.warning(f"Failed to remove temp file: {e}")

@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Global exception handler."""
    logger.error(f"Unhandled exception: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "error": "Internal server error",
            "message": str(exc)
        }
    )

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
