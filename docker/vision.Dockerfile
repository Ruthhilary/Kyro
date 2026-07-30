# Kyro Vision Engine
# GPU-accelerated YOLO + ByteTrack inference worker
FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

WORKDIR /app

# System deps for OpenCV
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxrender1 libxext6 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Python deps
COPY ai/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy AI source
COPY ai/ ./ai/

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

CMD ["python", "-m", "ai.worker"]
