"""
Kyro — Person Detector

Wraps YOLOv8 to detect every visible person in a camera frame.
Returns normalised bounding boxes, confidence scores, and class IDs.

Design decisions:
- Single responsibility: this module ONLY detects, it does not track.
- Device selection is automatic: CUDA → MPS → CPU fallback.
- Model is loaded once at construction and reused across frames.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from ultralytics import YOLO

from ai.config import DetectionConfig

logger = logging.getLogger(__name__)


@dataclass
class Detection:
    """A single person detection result from one frame."""

    # Bounding box in absolute pixel coordinates [x1, y1, x2, y2]
    bbox: np.ndarray  # shape (4,)

    # Detection confidence [0.0, 1.0]
    confidence: float

    # COCO class ID (always 0 = person for this detector)
    class_id: int = 0

    @property
    def xyxy(self) -> tuple[float, float, float, float]:
        return tuple(self.bbox.tolist())  # type: ignore

    @property
    def center(self) -> tuple[float, float]:
        x1, y1, x2, y2 = self.bbox
        return ((x1 + x2) / 2, (y1 + y2) / 2)

    @property
    def area(self) -> float:
        x1, y1, x2, y2 = self.bbox
        return max(0.0, x2 - x1) * max(0.0, y2 - y1)

    def to_tlwh(self) -> np.ndarray:
        """Convert [x1,y1,x2,y2] → [top, left, width, height] for tracker input."""
        x1, y1, x2, y2 = self.bbox
        return np.array([x1, y1, x2 - x1, y2 - y1], dtype=np.float32)


class PersonDetector:
    """
    GPU-accelerated person detector backed by YOLOv8.

    Usage:
        detector = PersonDetector(config)
        detections = detector.detect(frame)   # frame is a BGR numpy array
    """

    def __init__(self, cfg: DetectionConfig) -> None:
        self._cfg = cfg
        self._device = self._resolve_device(cfg.device)
        self._model = self._load_model(cfg.model_path, cfg.model_name)
        logger.info(
            "PersonDetector ready | model=%s device=%s conf=%.2f",
            cfg.model_name,
            self._device,
            cfg.confidence_threshold,
        )

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def detect(self, frame: np.ndarray) -> list[Detection]:
        """
        Run inference on a single BGR frame.

        Args:
            frame: H×W×3 numpy array in BGR colour order (OpenCV default).

        Returns:
            List of Detection objects, one per visible person.
        """
        results = self._model.predict(
            source=frame,
            conf=self._cfg.confidence_threshold,
            iou=self._cfg.iou_threshold,
            classes=self._cfg.target_classes,
            imgsz=self._cfg.imgsz,
            max_det=self._cfg.max_det,
            device=self._device,
            verbose=False,
        )

        detections: list[Detection] = []

        # ultralytics returns a list with one result per image
        for result in results:
            if result.boxes is None:
                continue
            boxes = result.boxes.xyxy.cpu().numpy()   # (N, 4)
            confs = result.boxes.conf.cpu().numpy()   # (N,)
            cls_ids = result.boxes.cls.cpu().numpy()  # (N,)

            for bbox, conf, cls_id in zip(boxes, confs, cls_ids):
                detections.append(
                    Detection(
                        bbox=bbox.astype(np.float32),
                        confidence=float(conf),
                        class_id=int(cls_id),
                    )
                )

        return detections

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _resolve_device(requested: str) -> str:
        """
        Resolve the best available compute device.
        Falls back gracefully: CUDA → MPS → CPU.
        """
        if requested == "cuda":
            if torch.cuda.is_available():
                logger.info("CUDA GPU detected: %s", torch.cuda.get_device_name(0))
                return "cuda"
            logger.warning("CUDA requested but not available — falling back to CPU")
            return "cpu"

        if requested == "mps":
            if torch.backends.mps.is_available():
                logger.info("Apple MPS device available")
                return "mps"
            logger.warning("MPS requested but not available — falling back to CPU")
            return "cpu"

        return "cpu"

    @staticmethod
    def _load_model(model_path: Path, model_name: str) -> YOLO:
        """
        Load YOLO model from local path if it exists,
        otherwise let ultralytics download it automatically.
        """
        if model_path.exists():
            logger.info("Loading YOLO model from %s", model_path)
            return YOLO(str(model_path))

        logger.info("Model not found locally — downloading %s", model_name)
        return YOLO(model_name)
