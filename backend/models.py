from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import DateTime, ForeignKey, Index, Integer, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id() -> str:
    return str(uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True, nullable=False)
    mobile: Mapped[str | None] = mapped_column(String(30))
    password_hash: Mapped[str] = mapped_column(String(256), nullable=False)
    role: Mapped[str] = mapped_column(String(20), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active")
    badge_number: Mapped[str | None] = mapped_column(String(80))
    jurisdiction: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    vehicles: Mapped[list["Vehicle"]] = relationship(back_populates="owner")


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"), index=True)
    plate: Mapped[str] = mapped_column(String(20), unique=True, index=True, nullable=False)
    make: Mapped[str | None] = mapped_column(String(80))
    model: Mapped[str | None] = mapped_column(String(80))
    year: Mapped[int | None] = mapped_column(Integer)
    colour: Mapped[str | None] = mapped_column(String(50))
    vehicle_type: Mapped[str | None] = mapped_column(String(40))
    fastag_id: Mapped[str | None] = mapped_column(String(80), unique=True, index=True)
    state: Mapped[str | None] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)

    owner: Mapped[User | None] = relationship(back_populates="vehicles")


class Fine(Base):
    __tablename__ = "fines"
    __table_args__ = (UniqueConstraint("run_id", "plate", "violation_type", name="uq_fine_run_plate_violation"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    challan_number: Mapped[str] = mapped_column(String(40), unique=True, index=True, nullable=False)
    vehicle_id: Mapped[str | None] = mapped_column(ForeignKey("vehicles.id", ondelete="SET NULL"), index=True)
    plate: Mapped[str] = mapped_column(String(20), nullable=False, index=True)
    violation_type: Mapped[str] = mapped_column(String(60), nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    plate_status: Mapped[str] = mapped_column(String(30), nullable=False, default="confirmed")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="unpaid", index=True)
    run_id: Mapped[str] = mapped_column(String(100), nullable=False)
    evidence_path: Mapped[str | None] = mapped_column(Text)
    video_path: Mapped[str | None] = mapped_column(Text)


class Payment(Base):
    __tablename__ = "fine_payments"
    __table_args__ = (UniqueConstraint("fine_id", name="uq_payment_fine"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    fine_id: Mapped[str] = mapped_column(ForeignKey("fines.id", ondelete="RESTRICT"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True, nullable=False)
    receipt_number: Mapped[str] = mapped_column(String(40), unique=True, index=True, nullable=False)
    method: Mapped[str] = mapped_column(String(20), nullable=False)
    amount: Mapped[float] = mapped_column(Numeric(10, 2), nullable=False)
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    message: Mapped[str] = mapped_column(String(500), nullable=False)
    incident_id: Mapped[str | None] = mapped_column(ForeignKey("incidents.id", ondelete="SET NULL"), index=True)
    fine_id: Mapped[str | None] = mapped_column(ForeignKey("fines.id", ondelete="SET NULL"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Incident(Base):
    __tablename__ = "incidents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    event_id: Mapped[str] = mapped_column(String(160), unique=True, index=True, nullable=False)
    run_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    junction_id: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="unresolved", index=True)
    severity: Mapped[str] = mapped_column(String(20), nullable=False, default="unknown")
    position_json: Mapped[str | None] = mapped_column(Text)
    involved_plates_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    evidence_path: Mapped[str | None] = mapped_column(Text)
    resolved_by: Mapped[str | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RFIDRead(Base):
    __tablename__ = "rfid_reads"
    __table_args__ = (Index("ix_rfid_junction_time", "junction_id", "read_at"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    epc: Mapped[str] = mapped_column(String(120), index=True, nullable=False)
    junction_id: Mapped[str] = mapped_column(String(40), nullable=False, index=True)
    rssi: Mapped[float | None] = mapped_column(Numeric(8, 2))
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False, index=True)
    window_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    window_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class IncidentTag(Base):
    __tablename__ = "incident_tags"
    __table_args__ = (UniqueConstraint("incident_id", "epc", name="uq_incident_tag"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True, nullable=False)
    epc: Mapped[str] = mapped_column(String(120), nullable=False)
    plate: Mapped[str | None] = mapped_column(String(20))
    crash_junction: Mapped[str] = mapped_column(String(40), nullable=False)
    peak_rssi: Mapped[float | None] = mapped_column(Numeric(8, 2))
    report_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class IncidentResponse(Base):
    __tablename__ = "incident_responses"
    __table_args__ = (UniqueConstraint("incident_id", "user_id", name="uq_incident_response_user"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True, nullable=False)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    accident_occurred: Mapped[bool] = mapped_column(nullable=False)
    responded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Sighting(Base):
    __tablename__ = "sightings"
    __table_args__ = (UniqueConstraint("incident_id", "epc", "junction_id", name="uq_incident_tag_junction"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    incident_id: Mapped[str] = mapped_column(ForeignKey("incidents.id", ondelete="CASCADE"), index=True, nullable=False)
    epc: Mapped[str] = mapped_column(String(120), nullable=False)
    junction_id: Mapped[str] = mapped_column(String(40), nullable=False)
    plate: Mapped[str | None] = mapped_column(String(20))
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    payload_json: Mapped[str] = mapped_column(Text, nullable=False, default="{}")


class RoutineJob(Base):
    __tablename__ = "routine_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    submitted_by: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True, nullable=False)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="queued", index=True)
    result_json: Mapped[str | None] = mapped_column(Text)
    error_message: Mapped[str | None] = mapped_column(String(500))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class PendingVerification(Base):
    __tablename__ = "pending_verification"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    run_id: Mapped[str] = mapped_column(String(100), nullable=False, index=True)
    pattern: Mapped[str] = mapped_column(String(40), nullable=False)
    candidate_plates_json: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    status: Mapped[str] = mapped_column(String(30), nullable=False, default="pending", index=True)
    snapshot_path: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class RevokedToken(Base):
    __tablename__ = "revoked_tokens"

    jti: Mapped[str] = mapped_column(String(36), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class Junction(Base):
    __tablename__ = "junctions"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    latitude: Mapped[float | None] = mapped_column(Numeric(10, 7))
    longitude: Mapped[float | None] = mapped_column(Numeric(10, 7))


class LiveCamera(Base):
    __tablename__ = "cameras"

    id: Mapped[str] = mapped_column(String(80), primary_key=True)
    junction_id: Mapped[str] = mapped_column(String(40), index=True, nullable=False)
    last_frame_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    latest_frame_path: Mapped[str | None] = mapped_column(Text)
