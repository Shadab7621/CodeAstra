"""Request models and enums (see docs/00_CONTRACT.md section 3)."""
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class IncidentType(str, Enum):
    flood = "flood"
    fire = "fire"
    road_blocked = "road_blocked"
    medical = "medical"


class Status(str, Enum):
    open = "open"
    acknowledged = "acknowledged"
    in_progress = "in_progress"
    resolved = "resolved"


# Higher rank wins when two nodes change status at the same time.
STATUS_RANK = {Status.open: 0, Status.acknowledged: 1, Status.in_progress: 2, Status.resolved: 3}


class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


class ReportCreate(BaseModel):
    incident_type: IncidentType
    severity: int = Field(ge=1, le=5)
    location: Location
    description: str = Field(max_length=500)
    reporter: str = Field(min_length=1, max_length=100)
    status: Status = Status.open


class ReportPatch(BaseModel):
    severity: Optional[int] = Field(default=None, ge=1, le=5)
    status: Optional[Status] = None
    location: Optional[Location] = None
    description: Optional[str] = Field(default=None, max_length=500)


class ResolveBody(BaseModel):
    chosen_event_id: str
    operator: str = Field(min_length=1, max_length=100)


class ClockBody(BaseModel):
    offset_ms: int


class PeerBody(BaseModel):
    peer: str
