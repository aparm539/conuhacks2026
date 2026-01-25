#!/bin/bash
# Build the fluid-helper Swift CLI for macOS
# This creates a universal binary for both Intel and Apple Silicon Macs

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HELPER_DIR="$PROJECT_ROOT/src/fluid-helper"
BIN_DIR="$PROJECT_ROOT/bin"

echo "Building fluid-helper..."

# Navigate to the Swift package directory
cd "$HELPER_DIR"

# Build universal binary for both arm64 and x86_64
echo "Compiling for arm64 and x86_64..."
swift build -c release --arch arm64 --arch x86_64

# Create bin directory if it doesn't exist
mkdir -p "$BIN_DIR"

# Copy the built binary to bin/
# Note: Universal binaries are in .build/apple/Products/Release/
if [ -f ".build/apple/Products/Release/fluid-helper" ]; then
    cp ".build/apple/Products/Release/fluid-helper" "$BIN_DIR/"
    echo "Built fluid-helper (universal binary) to $BIN_DIR/fluid-helper"
elif [ -f ".build/release/fluid-helper" ]; then
    # Fallback for single-arch builds
    cp ".build/release/fluid-helper" "$BIN_DIR/"
    echo "Built fluid-helper to $BIN_DIR/fluid-helper"
else
    echo "ERROR: Could not find built binary"
    exit 1
fi

# Make it executable
chmod +x "$BIN_DIR/fluid-helper"

echo "Done!"
