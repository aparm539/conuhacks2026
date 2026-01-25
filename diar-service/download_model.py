#!/usr/bin/env python3
"""
Script to pre-download pyannote model during Docker build.
This bakes the model into the image for fast container startup.
"""
import os
import sys

# Set HuggingFace cache location
os.environ['HF_HOME'] = '/app/.cache/huggingface'
os.environ['HF_HUB_CACHE'] = '/app/.cache/huggingface'

# Patch torch.load for PyTorch 2.9.0 compatibility with pyannote-audio
import torch
_original_torch_load = torch.load
def _patched_torch_load(*args, **kwargs):
    kwargs['weights_only'] = False
    return _original_torch_load(*args, **kwargs)
torch.load = _patched_torch_load

# Get token from environment or command line
hf_token = os.environ.get('HF_TOKEN') or (sys.argv[1] if len(sys.argv) > 1 else None)

if not hf_token:
    print("ERROR: HF_TOKEN not provided")
    sys.exit(1)

print("Logging in to HuggingFace Hub...")
from huggingface_hub import login
login(token=hf_token)

print("Downloading pyannote speaker diarization model...")
from pyannote.audio import Pipeline
Pipeline.from_pretrained('pyannote/speaker-diarization-community-1', token=hf_token)

print("Model downloaded successfully!")
