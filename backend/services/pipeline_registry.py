"""
Kyro — Pipeline Registry

Central registry of all running VisionPipeline instances.
The FastAPI app registers pipelines here; routes access them by camera_id.
"""

from __future__ import annotations

from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from ai.pipeline import VisionPipeline


class PipelineRegistry:
    def __init__(self) -> None:
        self._pipelines: dict[str, "VisionPipeline"] = {}

    def register(self, camera_id: str, pipeline: "VisionPipeline") -> None:
        self._pipelines[camera_id] = pipeline

    def get(self, camera_id: str) -> Optional["VisionPipeline"]:
        return self._pipelines.get(camera_id)

    def all(self) -> dict[str, "VisionPipeline"]:
        return dict(self._pipelines)

    def unregister(self, camera_id: str) -> None:
        self._pipelines.pop(camera_id, None)


# Global singleton
pipeline_registry = PipelineRegistry()
