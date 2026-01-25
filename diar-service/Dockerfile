# Use Python base image (we'll install PyTorch 2.9.0 manually)
# This works on both GPU and CPU-only systems
FROM python:3.13-slim

# HuggingFace token for downloading gated models during build
ARG HF_TOKEN

# Set working directory
WORKDIR /app

# Install system dependencies
# ffmpeg is required by torchcodec audio decoding library
# libsndfile1 is required for audio file I/O
# build-essential may be needed for compiling some packages
# FFmpeg development libraries may be needed for some audio processing packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    build-essential \
    git \
    cmake \
    pkg-config \
    libavcodec-dev \
    libavformat-dev \
    libavutil-dev \
    libavdevice-dev \
    libavfilter-dev \
    libswresample-dev \
    libswscale-dev \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables
ENV PYANNOTE_CACHE=/app/.cache
ENV PYTHONUNBUFFERED=1
ENV GIT_TERMINAL_PROMPT=0
# HuggingFace cache location for model storage
ENV HF_HOME=/app/.cache/huggingface
ENV HF_HUB_CACHE=/app/.cache/huggingface

# Install uv package manager (recommended by pyannote-audio for better dependency resolution)
RUN pip install --no-cache-dir uv

# Copy pyproject.toml early so we can use uv add
COPY pyproject.toml .

# Initialize virtual environment
RUN uv venv

# Install PyTorch and torchaudio first (required for building torchcodec)
RUN uv pip install torch==2.9.0 torchaudio==2.9.0

# Install build dependencies required for torchcodec
RUN uv pip install pybind11 numpy

# Build torchcodec from source
RUN git clone --depth 1 --branch v0.7.0 https://github.com/meta-pytorch/torchcodec.git /tmp/torchcodec && \
    cd /tmp/torchcodec && \
    sed -i 's/-Werror/-Werror -Wno-deprecated-declarations/g' src/torchcodec/_core/CMakeLists.txt && \
    VIRTUAL_ENV=/app/.venv \
    I_CONFIRM_THIS_IS_NOT_A_LICENSE_VIOLATION=1 \
    CMAKE_PREFIX_PATH=/app/.venv/lib/python3.13/site-packages/pybind11/share/cmake \
    Python3_EXECUTABLE=/app/.venv/bin/python \
    uv pip install --no-build-isolation . && \
    cd /app && \
    rm -rf /tmp/torchcodec

# Copy requirements file
COPY requirements.txt .

# Install other Python dependencies (torchcodec is excluded from requirements.txt)
RUN uv pip install -r requirements.txt


# Copy application code
COPY app.py .
COPY download_model.py .

# Create cache directory
RUN mkdir -p /app/.cache /app/.cache/huggingface

# Pre-download pyannote model during build for fast container startup
# This bakes the model into the image, eliminating download time at runtime
RUN if [ -n "$HF_TOKEN" ]; then \
    /app/.venv/bin/python download_model.py "$HF_TOKEN"; \
    else \
    echo "WARNING: HF_TOKEN not provided, skipping model pre-download. Container startup will be slow."; \
    fi

# Expose port
EXPOSE 8000

# Run the FastAPI application with uvicorn (with auto-reload for development)
CMD ["uv", "run", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
