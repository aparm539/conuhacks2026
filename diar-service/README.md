# Docker Setup for pyannote-audio

This directory contains Docker configuration for running pyannote-audio as a backend service for the VS Code extension.

## Prerequisites

- Docker installed and running
- Docker Compose (optional, for easier management)
- HuggingFace account and access token (required for downloading pretrained models)

## Quick Start

### 1. Get HuggingFace Access Token

1. Create an account at [HuggingFace](https://huggingface.co/join)
2. Go to [Settings > Access Tokens](https://huggingface.co/settings/tokens)
3. Create a new token with read permissions
4. Accept the model user conditions for `pyannote/speaker-diarization-community-1` at [HuggingFace Model Page](https://huggingface.co/pyannote/speaker-diarization-community-1)

### 2. Build the Docker Image

```bash
docker build -t pyannote-audio:latest .
```

### 3. Run the Container

#### Using Docker directly:

```bash
# CPU-only
docker run -d \
  --name pyannote-service \
  -p 8000:8000 \
  -v pyannote-cache:/app/.cache \
  -v $(pwd)/audio-data:/app/audio-data \
  -e HF_TOKEN=your_huggingface_token_here \
  pyannote-audio:latest

# With GPU support (requires nvidia-docker)
docker run -d \
  --name pyannote-service \
  --gpus all \
  -p 8000:8000 \
  -v pyannote-cache:/app/.cache \
  -v $(pwd)/audio-data:/app/audio-data \
  -e HF_TOKEN=your_huggingface_token_here \
  pyannote-audio:latest
```

#### Using Docker Compose:

1. Create a `.env` file in the project root:
```bash
HF_TOKEN=your_huggingface_token_here
```

2. Start the service:
```bash
docker-compose up -d
```

3. View logs:
```bash
docker-compose logs -f
```

4. Stop the service:
```bash
docker-compose down
```

## GPU Support

The Docker image is built with CUDA support. To use GPU:

1. Install [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)

2. For Docker Compose, uncomment the GPU configuration in `docker-compose.yml`:
```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: 1
          capabilities: [gpu]
```

3. For Docker directly, use the `--gpus all` flag as shown above.

**Note:** The container will work on CPU-only systems even with the CUDA-enabled base image, but will be slower.

## Environment Variables

- `HF_TOKEN`: HuggingFace access token (required for downloading models)
- `PYANNOTE_CACHE`: Path to cache directory (default: `/app/.cache`)
- `PYTHONUNBUFFERED`: Set to 1 for immediate log output

## Volume Mounts

- `/app/.cache`: Persistent storage for downloaded models (mounted as Docker volume)
- `/app/audio-data`: Directory for audio input/output files (mounted from `./audio-data`)

## Usage Example

Once the container is running, you can use pyannote-audio in your Python code:

```python
from pyannote.audio import Pipeline

# Initialize pipeline (will use HF_TOKEN from environment)
pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1",
    use_auth_token=True
)

# Process audio file
diarization = pipeline("path/to/audio.wav")

# Process results (pyannote-audio 4.x returns DiarizeOutput with speaker_diarization)
for turn, speaker in diarization.speaker_diarization:
    print(f"Speaker {speaker}: {turn.start:.2f}s - {turn.end:.2f}s")
```

## Troubleshooting

### Models not downloading
- Ensure `HF_TOKEN` is set correctly
- Verify you've accepted the model user conditions on HuggingFace
- Check container logs: `docker logs pyannote-service`

### GPU not detected
- Verify NVIDIA drivers are installed: `nvidia-smi`
- Ensure NVIDIA Container Toolkit is installed
- Check Docker GPU support: `docker run --rm --gpus all nvidia/cuda:11.7.0-base-ubuntu22.04 nvidia-smi`

### Permission errors
- Ensure the `audio-data` directory exists and has proper permissions
- Check volume mount paths are correct

## Building for Production

For production deployments, consider:

1. Using a specific PyTorch version instead of `latest`
2. Adding health checks to the Dockerfile
3. Setting up proper logging and monitoring
4. Using secrets management for the HuggingFace token
5. Optimizing the image size with multi-stage builds if needed

## References

- [pyannote-audio GitHub](https://github.com/pyannote/pyannote-audio)
- [pyannote-audio Documentation](https://pyannote.github.io/pyannote-audio/)
- [HuggingFace Models](https://huggingface.co/pyannote)
