from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator


class CitizenRegistration(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    mobile: str = Field(min_length=7, max_length=30)
    password: str = Field(min_length=10, max_length=128)
    vehicle_registration_number: str = Field(min_length=4, max_length=20)

    @field_validator("vehicle_registration_number")
    @classmethod
    def normalize_plate(cls, value: str) -> str:
        return "".join(value.upper().split())


class AuthorityRegistration(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    badge_number: str = Field(min_length=2, max_length=80)
    jurisdiction: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=10, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    mobile: str | None = Field(default=None, min_length=7, max_length=30)


class FinePaymentRequest(BaseModel):
    method: Literal["upi", "card", "netbanking"]


class CrashConfirmationRequest(BaseModel):
    accident_occurred: bool


class VehicleRegistryRequest(BaseModel):
    plate: str = Field(min_length=4, max_length=20)
    fastag_id: str | None = Field(default=None, max_length=80)
    make: str | None = Field(default=None, max_length=80)
    model: str | None = Field(default=None, max_length=80)
    year: int | None = Field(default=None, ge=1900, le=2200)
    colour: str | None = Field(default=None, max_length=50)
    vehicle_type: str | None = Field(default=None, max_length=40)
    state: str | None = Field(default=None, max_length=50)


class ViolationEvent(BaseModel):
    run_id: str = Field(min_length=1, max_length=100)
    plate: str | None = Field(default=None, max_length=20)
    violation_type: str = Field(min_length=1, max_length=60)
    timestamp: datetime | None = None
    plate_status: Literal["confirmed", "low_confidence", "unreadable"] = "confirmed"
    pattern: str | None = Field(default=None, max_length=40)
    candidate_plates: list[str] = Field(default_factory=list, max_length=100)
    evidence_image_base64: str | None = None


class ResolveIncidentRequest(BaseModel):
    password: str = Field(min_length=1, max_length=128)


class CARLAEvent(BaseModel):
    model_config = ConfigDict(extra="allow")

    type: str


class IncidentResolution(BaseModel):
    incident_id: str
    status: str
    resolved_at: datetime
