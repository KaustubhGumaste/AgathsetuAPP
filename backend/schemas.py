from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator


class CitizenRegistration(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    mobile: str = Field(min_length=7, max_length=30)
    password: str = Field(min_length=8, max_length=128)
    vehicle_registration_number: str = Field(min_length=4, max_length=20)
    email_verification_token: str | None = Field(default=None, max_length=2000)

    @field_validator("vehicle_registration_number")
    @classmethod
    def normalize_plate(cls, value: str) -> str:
        return "".join(value.upper().split())


class AuthorityRegistration(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: EmailStr
    badge_number: str = Field(min_length=2, max_length=80)
    jurisdiction: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=8, max_length=128)
    email_verification_token: str | None = Field(default=None, max_length=2000)


class EmailOtpRequest(BaseModel):
    email: EmailStr


class EmailOtpVerify(BaseModel):
    email: EmailStr
    code: str = Field(pattern=r"^\d{6}$")


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ProfileUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    mobile: str | None = Field(default=None, min_length=7, max_length=30)


class FinePaymentRequest(BaseModel):
    method: Literal["upi", "card", "netbanking"]


class CrashConfirmationRequest(BaseModel):
    # need_help: send help · minor_ok: a small accident, nobody needs help · false_alarm: no accident.
    outcome: Literal["need_help", "minor_ok", "false_alarm"] | None = None
    # Older app versions send only this yes/no.
    accident_occurred: bool | None = None

    @model_validator(mode="after")
    def require_answer(self) -> "CrashConfirmationRequest":
        if self.outcome is None and self.accident_occurred is None:
            raise ValueError("Send outcome (need_help, minor_ok or false_alarm).")
        return self


class CenterCreate(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    phone: str | None = Field(default=None, max_length=30)


class CenterUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    latitude: float | None = Field(default=None, ge=-90, le=90)
    longitude: float | None = Field(default=None, ge=-180, le=180)
    phone: str | None = Field(default=None, max_length=30)
    active: bool | None = None


class MyCenterRequest(BaseModel):
    center_id: str | None = Field(default=None, max_length=36)


class GoogleSignInRequest(BaseModel):
    id_token: str = Field(min_length=20, max_length=4096)
    # Which sign-in portal the person used. Only the citizen portal creates new accounts.
    portal: Literal["citizen", "authority", "admin"] = "citizen"


class AddVehicleRequest(BaseModel):
    vehicle_registration_number: str = Field(min_length=4, max_length=20)

    @field_validator("vehicle_registration_number")
    @classmethod
    def normalize_plate(cls, value: str) -> str:
        return "".join(value.upper().split())


class LiveLocationUpdate(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    accuracy_m: float | None = Field(default=None, ge=0, le=100000)


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
