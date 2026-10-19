import asyncio
import base64
import binascii
import hmac
import json
import logging
import os
import re
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

import jwt
from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import Engine, delete, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, sessionmaker

from .database import Base, engine
from .models import (
    Fine,
    Incident,
    IncidentResponse,
    IncidentTag,
    Junction,
    LiveCamera,
    Notification,
    Payment,
    PendingVerification,
    RFIDRead,
    RevokedToken,
    RoutineJob,
    Sighting,
    User,
    Vehicle,
    new_id,
    utcnow,
)
from .schemas import (
    AuthorityRegistration,
    CrashConfirmationRequest,
    CitizenRegistration,
    FinePaymentRequest,
    LoginRequest,
    ProfileUpdate,
    ResolveIncidentRequest,
    VehicleRegistryRequest,
    ViolationEvent,
)
from .security import (
    JWT_TTL_MINUTES,
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger("aghatsethu")
bearer = HTTPBearer(auto_error=False)
MEDIA_ROOT = Path(os.getenv("MEDIA_DIR", "backend/media")).resolve()
MAX_VIDEO_BYTES = int(os.getenv("MAX_VIDEO_BYTES", str(500 * 1024 * 1024)))
FRAME_FRESH_SECONDS = int(os.getenv("CAMERA_FRAME_FRESH_SECONDS", "15"))
FINE_AMOUNTS = {"NO HELMET": 1000.0, "TRIPLE RIDING": 1000.0}
JUNCTION_IDS = ("J01", "J02", "J03")


def parse_datetime(value: Any) -> datetime:
    if isinstance(value, (int, float)):
        parsed = datetime.fromtimestamp(float(value), timezone.utc)
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            parsed = utcnow()
    else:
        parsed = utcnow()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def utc_aware(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def json_object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def json_list(value: str | None) -> list[Any]:
    if not value:
        return []
    try:
        decoded = json.loads(value)
    except json.JSONDecodeError:
        return []
    return decoded if isinstance(decoded, list) else []


def plate_value(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    plate = re.sub(r"\s+", "", value.upper())
    return plate or None


def public_user(user: User) -> dict[str, Any]:
    result: dict[str, Any] = {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "mobile": user.mobile,
        "role": user.role,
        "status": user.status,
        "created_at": iso(user.created_at),
    }
    if user.role != "citizen":
        result["badge_number"] = user.badge_number
        result["jurisdiction"] = user.jurisdiction
    return result


def public_vehicle(vehicle: Vehicle) -> dict[str, Any]:
    return {
        "id": vehicle.id,
        "vehicle_registration_number": vehicle.plate,
        "plate_number": vehicle.plate,
        "make": vehicle.make,
        "model": vehicle.model,
        "year": vehicle.year,
        "colour": vehicle.colour,
        "type": vehicle.vehicle_type,
        "fastag_id": vehicle.fastag_id,
        "state": vehicle.state,
    }


def public_fine(fine: Fine) -> dict[str, Any]:
    return {
        "id": fine.id,
        "fine_id": fine.id,
        "challan_number": fine.challan_number,
        "vehicle_id": fine.vehicle_id,
        "plate_number": fine.plate,
        "violation_type": fine.violation_type,
        "amount": float(fine.amount),
        "issued_at": iso(fine.issued_at),
        "created_at": iso(fine.issued_at),
        "plate_status": fine.plate_status,
        "status": fine.status,
        "run_id": fine.run_id,
    }


def public_payment(payment: Payment, fine: Fine | None = None) -> dict[str, Any]:
    return {
        "id": payment.id,
        "receipt_number": payment.receipt_number,
        "fine_id": payment.fine_id,
        "challan_number": fine.challan_number if fine else None,
        "plate_number": fine.plate if fine else None,
        "amount": float(payment.amount),
        "method": payment.method,
        "paid_at": iso(payment.paid_at),
    }


def public_notification(notification: Notification) -> dict[str, Any]:
    return {
        "id": notification.id,
        "kind": notification.kind,
        "message": notification.message,
        "incident_id": notification.incident_id,
        "fine_id": notification.fine_id,
        "created_at": iso(notification.created_at),
        "read_at": iso(notification.read_at),
    }


def public_incident(incident: Incident, *, citizen: bool = False) -> dict[str, Any]:
    involved = json_list(incident.involved_plates_json)
    result: dict[str, Any] = {
        "id": incident.id,
        "incident_id": incident.id,
        "event_id": incident.event_id,
        "run_id": incident.run_id,
        "junction_id": incident.junction_id,
        "occurred_at": iso(incident.occurred_at),
        "time": iso(incident.occurred_at),
        "status": incident.status,
        "severity": incident.severity,
        "position": json.loads(incident.position_json) if incident.position_json else None,
        "vehicle_count": len(involved),
        "involved_vehicles": involved if not citizen else len(involved),
        "resolved_at": iso(incident.resolved_at),
    }
    if not citizen:
        result["evidence_available"] = bool(incident.evidence_path)
        result["timeline"] = json.loads(incident.payload_json)
    return result


def list_response(items: list[dict[str, Any]], total: int, limit: int, offset: int) -> dict[str, Any]:
    return {"items": items, "total": total, "limit": limit, "offset": offset}


def _persist_image(data: str, identifier: str) -> str | None:
    encoded = data
    if "," in data and data.split(",", 1)[0].lower().startswith("data:image/"):
        encoded = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        return None
    if not raw.startswith(b"\xff\xd8\xff") or len(raw) > 20 * 1024 * 1024:
        return None
    relative = Path("evidence") / f"{identifier}.jpg"
    target = (MEDIA_ROOT / relative).resolve()
    if MEDIA_ROOT not in target.parents:
        raise ValueError("Evidence path escaped the media directory.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)
    return relative.as_posix()


def _camera_state(camera: LiveCamera, now: datetime) -> str:
    if camera.last_frame_at is None:
        return "offline"
    last_seen = camera.last_frame_at
    last_seen = utc_aware(last_seen)
    return "online" if (now - last_seen).total_seconds() <= FRAME_FRESH_SECONDS else "offline"


def create_app(database_engine: Engine = engine) -> FastAPI:
    factory = sessionmaker(bind=database_engine, autoflush=False, expire_on_commit=False)

    def get_db():
        db = factory()
        try:
            yield db
        finally:
            db.close()

    def current_user(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
        db: Session = Depends(get_db),
    ) -> User:
        if credentials is None or credentials.scheme.lower() != "bearer":
            raise HTTPException(status_code=401, detail="Bearer authentication is required.", headers={"WWW-Authenticate": "Bearer"})
        token = credentials.credentials
        claims = decode_access_token(token)
        if claims is None:
            raise HTTPException(status_code=401, detail="Invalid or expired access token.", headers={"WWW-Authenticate": "Bearer"})
        if db.get(RevokedToken, str(claims["jti"])) is not None:
            raise HTTPException(status_code=401, detail="Access token has been revoked.", headers={"WWW-Authenticate": "Bearer"})
        user = db.get(User, str(claims["sub"]))
        if user is None or user.status != "active":
            raise HTTPException(status_code=403, detail="Account is not active.")
        return user

    def require_roles(*roles: str):
        def dependency(user: User = Depends(current_user)) -> User:
            if user.role not in roles:
                raise HTTPException(status_code=403, detail="Your role is not authorized for this resource.")
            return user
        return dependency

    async def broadcast(event: dict[str, Any]) -> None:
        async with application.state.socket_lock:
            sockets = list(application.state.authority_sockets)
        stale: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(event)
            except (RuntimeError, WebSocketDisconnect):
                stale.append(socket)
        if stale:
            async with application.state.socket_lock:
                for socket in stale:
                    application.state.authority_sockets.discard(socket)

    async def notify_citizen(user_id: str, event: dict[str, Any]) -> None:
        async with application.state.socket_lock:
            sockets = [socket for socket, socket_user_id in application.state.citizen_sockets if socket_user_id == user_id]
        stale: list[WebSocket] = []
        for socket in sockets:
            try:
                await socket.send_json(event)
            except (RuntimeError, WebSocketDisconnect):
                stale.append(socket)
        if stale:
            async with application.state.socket_lock:
                application.state.citizen_sockets = {
                    (socket, socket_user_id)
                    for socket, socket_user_id in application.state.citizen_sockets
                    if socket not in stale
                }

    def create_bootstrap_admin(db: Session) -> None:
        email = os.getenv("BOOTSTRAP_ADMIN_EMAIL", "").strip().lower()
        password = os.getenv("BOOTSTRAP_ADMIN_PASSWORD", "")
        if not email and not password:
            return
        if not email or len(password) < 12:
            raise RuntimeError("Set both BOOTSTRAP_ADMIN_EMAIL and a BOOTSTRAP_ADMIN_PASSWORD of at least 12 characters.")
        if db.scalar(select(User).where(User.email == email)):
            return
        db.add(User(name="System Administrator", email=email, password_hash=hash_password(password), role="admin", status="active"))
        db.commit()
        logger.warning("Created bootstrap admin account from environment configuration.")

    def initialize_database() -> None:
        MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
        Base.metadata.create_all(database_engine)
        with factory() as db:
            db.execute(delete(RevokedToken).where(RevokedToken.expires_at < utcnow()))
            for junction_id in JUNCTION_IDS:
                if db.get(Junction, junction_id) is None:
                    db.add(Junction(id=junction_id, name=f"Junction {junction_id}"))
                if db.get(LiveCamera, f"CAM-{junction_id}") is None:
                    db.add(LiveCamera(id=f"CAM-{junction_id}", junction_id=junction_id))
            db.commit()
            create_bootstrap_admin(db)

    @asynccontextmanager
    async def lifespan(_application: FastAPI):
        initialize_database()
        yield

    application = FastAPI(
        title="AGHAT SETHU API",
        version="1.0.0",
        description="Traffic incident investigation and citizen services API.",
        lifespan=lifespan,
    )
    application.state.session_factory = factory
    application.state.authority_sockets = set()
    application.state.citizen_sockets = set()
    application.state.socket_lock = asyncio.Lock()
    application.state.camera_frames = {}
    configured_origins = os.getenv(
        "CORS_ORIGINS",
        "http://localhost:8081,http://127.0.0.1:8081,http://[::1]:8081",
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=[origin.strip() for origin in configured_origins.split(",") if origin.strip()],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["Authorization", "Content-Type"],
    )

    @application.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": "aghat-sethu-api"}

    def insert_user(db: Session, user: User) -> None:
        db.add(user)
        try:
            db.flush()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(status_code=409, detail="An account or vehicle with those details already exists.") from error

    @application.post("/api/auth/register/citizen", status_code=201)
    async def register_citizen(request: CitizenRegistration, db: Session = Depends(get_db)) -> dict[str, Any]:
        email = str(request.email).lower()
        user = User(
            name=request.name.strip(),
            email=email,
            mobile=request.mobile.strip(),
            password_hash=hash_password(request.password),
            role="citizen",
            status="active",
        )
        db.add(user)
        plate = plate_value(request.vehicle_registration_number)
        if not plate:
            raise HTTPException(status_code=422, detail="Vehicle registration number is required.")
        db.add(Vehicle(owner=user, plate=plate))
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(status_code=409, detail="An account or vehicle with those details already exists.") from error
        return {"user": public_user(user), "message": "Citizen account registered."}

    @application.post("/api/auth/register/authority", status_code=201)
    async def register_authority(request: AuthorityRegistration, db: Session = Depends(get_db)) -> dict[str, Any]:
        email = str(request.email).lower()
        user = User(
            name=request.name.strip(),
            email=email,
            password_hash=hash_password(request.password),
            role="authority",
            status="pending",
            badge_number=request.badge_number.strip(),
            jurisdiction=request.jurisdiction.strip(),
        )
        insert_user(db, user)
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(status_code=409, detail="An account or badge number with those details already exists.") from error
        return {"user": public_user(user), "message": "Officer account is awaiting approval."}

    @application.post("/api/auth/login")
    async def login(request: LoginRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
        user = db.scalar(select(User).where(User.email == str(request.email).lower()))
        if user is None or not verify_password(request.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Email or password is incorrect.", headers={"WWW-Authenticate": "Bearer"})
        if user.status == "pending":
            raise HTTPException(status_code=403, detail="Authority account is awaiting approval.")
        if user.status != "active":
            raise HTTPException(status_code=403, detail="Account is not active.")
        access_token, _token_id, _expires_at = create_access_token(user)
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "expires_in": JWT_TTL_MINUTES * 60,
            "user": public_user(user),
        }

    @application.get("/api/auth/me")
    async def get_me(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        result = public_user(user)
        if user.role == "citizen":
            vehicles = db.scalars(select(Vehicle).where(Vehicle.owner_id == user.id).order_by(Vehicle.created_at)).all()
            result["vehicles"] = [public_vehicle(vehicle) for vehicle in vehicles]
        return result

    @application.patch("/api/auth/me")
    async def update_me(request: ProfileUpdate, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict[str, Any]:
        if request.name is None and request.mobile is None:
            raise HTTPException(status_code=422, detail="Provide name or mobile to update.")
        if request.name is not None:
            user.name = request.name.strip()
        if request.mobile is not None:
            user.mobile = request.mobile.strip()
        db.commit()
        return public_user(user)

    @application.post("/api/auth/logout")
    async def logout(
        credentials: HTTPAuthorizationCredentials | None = Depends(bearer),
        user: User = Depends(current_user),
        db: Session = Depends(get_db),
    ) -> dict[str, str]:
        del user
        if credentials is None:
            raise HTTPException(status_code=401, detail="Bearer authentication is required.")
        claims = decode_access_token(credentials.credentials)
        if claims is None:
            raise HTTPException(status_code=401, detail="Invalid access token.")
        expires_at = datetime.fromtimestamp(int(claims["exp"]), timezone.utc)
        db.merge(RevokedToken(jti=str(claims["jti"]), expires_at=expires_at))
        db.commit()
        return {"message": "Signed out."}

    @application.get("/api/admin/authority-accounts")
    async def pending_authority_accounts(
        _admin: User = Depends(require_roles("admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        users = db.scalars(select(User).where(User.role == "authority", User.status == "pending").order_by(User.created_at)).all()
        return {"items": [public_user(user) for user in users], "total": len(users)}

    @application.post("/api/admin/authority-accounts/{user_id}/approve")
    async def approve_authority(
        user_id: str,
        _admin: User = Depends(require_roles("admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        user = db.get(User, user_id)
        if user is None or user.role != "authority":
            raise HTTPException(status_code=404, detail="Authority account not found.")
        if user.status == "pending":
            user.status = "active"
            db.commit()
        return public_user(user)

    @application.get("/api/citizen/vehicles")
    async def citizen_vehicles(
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        vehicles = db.scalars(select(Vehicle).where(Vehicle.owner_id == user.id).order_by(Vehicle.created_at)).all()
        return {"items": [public_vehicle(vehicle) for vehicle in vehicles], "total": len(vehicles)}

    def citizen_fines_query(db: Session, user: User):
        return select(Fine).join(Vehicle, Fine.vehicle_id == Vehicle.id).where(Vehicle.owner_id == user.id)

    @application.get("/api/citizen/fines")
    async def citizen_fines(
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        status: str | None = None,
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = citizen_fines_query(db, user)
        if status:
            query = query.where(Fine.status == status.lower())
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        fines = db.scalars(query.order_by(Fine.issued_at.desc()).offset(offset).limit(limit)).all()
        all_fines = db.scalars(citizen_fines_query(db, user)).all()
        unpaid = [fine for fine in all_fines if fine.status == "unpaid"]
        return {
            **list_response([public_fine(fine) for fine in fines], total, limit, offset),
            "registered_vehicles": db.scalar(select(func.count()).select_from(Vehicle).where(Vehicle.owner_id == user.id)) or 0,
            "fines_issued": len(all_fines),
            "unpaid_fines": len(unpaid),
            "total_unpaid": round(sum(float(fine.amount) for fine in unpaid), 2),
        }

    def citizen_fine_or_404(fine_id: str, user: User, db: Session) -> Fine:
        fine = db.scalar(
            select(Fine)
            .join(Vehicle, Fine.vehicle_id == Vehicle.id)
            .where(Fine.id == fine_id, Vehicle.owner_id == user.id)
        )
        if fine is None:
            raise HTTPException(status_code=404, detail="Fine not found.")
        return fine

    @application.post("/api/citizen/fines/{fine_id}/pay")
    async def pay_fine(
        fine_id: str,
        request: FinePaymentRequest,
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        fine = citizen_fine_or_404(fine_id, user, db)
        if fine.status == "paid":
            raise HTTPException(status_code=409, detail="Fine has already been paid.")
        receipt = f"AGH-{datetime.now(timezone.utc):%Y%m%d}-{secrets.token_hex(4).upper()}"
        payment = Payment(
            fine_id=fine.id,
            user_id=user.id,
            receipt_number=receipt,
            method=request.method,
            amount=fine.amount,
        )
        fine.status = "paid"
        db.add(payment)
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(status_code=409, detail="Payment could not be recorded; retry after checking payment history.") from error
        return {"payment": public_payment(payment, fine), "fine": public_fine(fine), "gateway": "simulated"}

    @application.get("/api/citizen/payments")
    async def citizen_payments(
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = select(Payment).where(Payment.user_id == user.id)
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        payments = db.scalars(query.order_by(Payment.paid_at.desc()).offset(offset).limit(limit)).all()
        items = []
        for payment in payments:
            items.append(public_payment(payment, db.get(Fine, payment.fine_id)))
        return list_response(items, total, limit, offset)

    @application.get("/api/citizen/notifications")
    async def citizen_notifications(
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = select(Notification).where(Notification.user_id == user.id)
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        notifications = db.scalars(query.order_by(Notification.created_at.desc()).offset(offset).limit(limit)).all()
        return list_response([public_notification(item) for item in notifications], total, limit, offset)

    @application.post("/api/citizen/notifications/{notification_id}/read")
    async def mark_notification_read(
        notification_id: str,
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        notification = db.scalar(select(Notification).where(Notification.id == notification_id, Notification.user_id == user.id))
        if notification is None:
            raise HTTPException(status_code=404, detail="Notification not found.")
        notification.read_at = notification.read_at or utcnow()
        db.commit()
        return public_notification(notification)

    @application.post("/api/citizen/notifications/read-all")
    async def mark_all_notifications_read(
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, int]:
        unread = db.scalars(select(Notification).where(Notification.user_id == user.id, Notification.read_at.is_(None))).all()
        for item in unread:
            item.read_at = utcnow()
        db.commit()
        return {"updated": len(unread)}

    @application.get("/api/citizen/incidents/{incident_id}")
    async def citizen_incident(
        incident_id: str,
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        incident = db.get(Incident, incident_id)
        if incident is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        plates = json_list(incident.involved_plates_json)
        owned = db.scalar(
            select(Vehicle.id).where(Vehicle.owner_id == user.id, Vehicle.plate.in_(plates)).limit(1)
        ) if plates else None
        if not owned:
            raise HTTPException(status_code=404, detail="Incident not found.")
        response = db.scalar(
            select(IncidentResponse).where(IncidentResponse.incident_id == incident.id, IncidentResponse.user_id == user.id)
        )
        result = public_incident(incident, citizen=True)
        result["response"] = (
            {"accident_occurred": response.accident_occurred, "responded_at": iso(response.responded_at)}
            if response
            else None
        )
        return result

    @application.post("/api/citizen/incidents/{incident_id}/confirm")
    async def confirm_citizen_incident(
        incident_id: str,
        request: CrashConfirmationRequest,
        user: User = Depends(require_roles("citizen")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        incident = db.get(Incident, incident_id)
        if incident is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        plates = json_list(incident.involved_plates_json)
        owns_vehicle = db.scalar(
            select(Vehicle.id).where(Vehicle.owner_id == user.id, Vehicle.plate.in_(plates)).limit(1)
        ) if plates else None
        if not owns_vehicle:
            raise HTTPException(status_code=404, detail="Incident not found.")
        response = db.scalar(
            select(IncidentResponse).where(IncidentResponse.incident_id == incident.id, IncidentResponse.user_id == user.id)
        )
        if response is None:
            response = IncidentResponse(
                incident_id=incident.id,
                user_id=user.id,
                accident_occurred=request.accident_occurred,
            )
            db.add(response)
        else:
            response.accident_occurred = request.accident_occurred
            response.responded_at = utcnow()
        db.commit()
        result = {
            "incident_id": incident.id,
            "accident_occurred": response.accident_occurred,
            "responded_at": iso(response.responded_at),
        }
        await broadcast(
            {
                "type": "citizen_crash_confirmation",
                **result,
                "citizen_id": user.id,
            }
        )
        return result

    @application.get("/api/citizen/fines/{fine_id}/snapshot")
    async def citizen_fine_snapshot(fine_id: str, user: User = Depends(require_roles("citizen")), db: Session = Depends(get_db)):
        fine = citizen_fine_or_404(fine_id, user, db)
        return serve_media(fine.evidence_path)

    @application.get("/api/citizen/fines/{fine_id}/clip")
    async def citizen_fine_clip(fine_id: str, user: User = Depends(require_roles("citizen")), db: Session = Depends(get_db)):
        fine = citizen_fine_or_404(fine_id, user, db)
        return serve_media(fine.video_path)

    def serve_media(relative_path: str | None):
        if not relative_path:
            raise HTTPException(status_code=404, detail="Evidence file is not available.")
        from fastapi.responses import FileResponse

        candidate = (MEDIA_ROOT / relative_path).resolve()
        if MEDIA_ROOT not in candidate.parents or not candidate.is_file():
            raise HTTPException(status_code=404, detail="Evidence file is not available.")
        return FileResponse(candidate)

    def authority_fines_query(db: Session, status: str | None, year: int | None):
        query = select(Fine)
        if status and status.lower() in {"paid", "unpaid"}:
            query = query.where(Fine.status == status.lower())
        if year:
            start = datetime(year, 1, 1, tzinfo=timezone.utc)
            end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            query = query.where(Fine.issued_at >= start, Fine.issued_at < end)
        return query

    @application.get("/api/authority/fines")
    async def authority_fines(
        status: str | None = None,
        year: int | None = Query(default=None, ge=2000, le=2200),
        limit: int = Query(default=200, ge=1, le=1000),
        offset: int = Query(default=0, ge=0),
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = authority_fines_query(db, status, year)
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        fines = db.scalars(query.order_by(Fine.issued_at.desc()).offset(offset).limit(limit)).all()
        all_fines = db.scalars(authority_fines_query(db, None, year)).all()
        paid_total = round(sum(float(fine.amount) for fine in all_fines if fine.status == "paid"), 2)
        unpaid_total = round(sum(float(fine.amount) for fine in all_fines if fine.status == "unpaid"), 2)
        monthly: dict[str, dict[str, float | int]] = {}
        for fine in all_fines:
            month = fine.issued_at.strftime("%Y-%m")
            item = monthly.setdefault(month, {"issued": 0, "revenue": 0.0, "pending": 0.0})
            item["issued"] = int(item["issued"]) + 1
            key = "revenue" if fine.status == "paid" else "pending"
            item[key] = round(float(item[key]) + float(fine.amount), 2)
        return {
            **list_response([public_fine(fine) for fine in fines], total, limit, offset),
            "fines_issued": len(all_fines),
            "revenue_collected": paid_total,
            "pending_amount": unpaid_total,
            "monthly": [{"month": month, **values} for month, values in sorted(monthly.items())],
        }

    @application.get("/api/authority/fines/{fine_id}")
    async def authority_fine_detail(
        fine_id: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        fine = db.get(Fine, fine_id)
        if fine is None:
            raise HTTPException(status_code=404, detail="Fine not found.")
        vehicle = db.get(Vehicle, fine.vehicle_id) if fine.vehicle_id else None
        owner = db.get(User, vehicle.owner_id) if vehicle and vehicle.owner_id else None
        result = public_fine(fine)
        result["evidence_url"] = f"/api/authority/fines/{fine.id}/snapshot" if fine.evidence_path else None
        result["vehicle"] = public_vehicle(vehicle) if vehicle else None
        result["owner"] = {"name": owner.name, "email": owner.email} if owner else None
        return result

    @application.get("/api/authority/fines/{fine_id}/snapshot")
    async def authority_fine_snapshot(
        fine_id: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ):
        fine = db.get(Fine, fine_id)
        if fine is None:
            raise HTTPException(status_code=404, detail="Fine not found.")
        return serve_media(fine.evidence_path)

    @application.get("/api/authority/pending-verifications")
    async def pending_verifications(
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = select(PendingVerification).where(PendingVerification.status == "pending")
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        rows = db.scalars(query.order_by(PendingVerification.created_at.desc()).offset(offset).limit(limit)).all()
        items = [
            {
                "id": row.id,
                "run_id": row.run_id,
                "pattern": row.pattern,
                "candidate_plates": json_list(row.candidate_plates_json),
                "status": row.status,
                "created_at": iso(row.created_at),
            }
            for row in rows
        ]
        return list_response(items, total, limit, offset)

    @application.get("/api/authority/pending-verifications/{verification_id}/snapshot")
    async def pending_verification_snapshot(
        verification_id: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ):
        row = db.get(PendingVerification, verification_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Pending verification not found.")
        return serve_media(row.snapshot_path)

    @application.get("/api/authority/summary")
    async def authority_summary(
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        incidents = db.scalars(select(Incident).order_by(Incident.occurred_at.desc()).limit(10)).all()
        fines = db.scalars(select(Fine)).all()
        cameras = db.scalars(select(LiveCamera)).all()
        now = utcnow()
        latest_crash = incidents[0] if incidents else None
        return {
            "crashes_detected": db.scalar(select(func.count()).select_from(Incident)) or 0,
            "unresolved_crashes": db.scalar(select(func.count()).select_from(Incident).where(Incident.status == "unresolved")) or 0,
            "traffic_violations_detected": len(fines),
            "fines_pending": sum(1 for fine in fines if fine.status == "unpaid"),
            "fines_pending_amount": round(sum(float(fine.amount) for fine in fines if fine.status == "unpaid"), 2),
            "recent_crashes": [public_incident(item) for item in incidents],
            "latest_crash_frame": f"/api/incidents/{latest_crash.id}/evidence/latest" if latest_crash and latest_crash.evidence_path else None,
            "violations_by_type": {
                kind: sum(1 for fine in fines if fine.violation_type == kind)
                for kind in sorted({fine.violation_type for fine in fines})
            },
            "cameras_online": sum(1 for camera in cameras if _camera_state(camera, now) == "online"),
        }

    @application.get("/api/authority/junctions")
    async def authority_junctions(
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        junctions = db.scalars(select(Junction).order_by(Junction.id)).all()
        now = utcnow()
        items = []
        for junction in junctions:
            camera = db.scalar(select(LiveCamera).where(LiveCamera.junction_id == junction.id))
            crashes = db.scalar(select(func.count()).select_from(Incident).where(Incident.junction_id == junction.id)) or 0
            sightings = db.scalar(select(func.count()).select_from(Sighting).where(Sighting.junction_id == junction.id)) or 0
            items.append(
                {
                    "junction_id": junction.id,
                    "name": junction.name,
                    "camera_state": _camera_state(camera, now) if camera else "offline",
                    "last_frame_at": iso(camera.last_frame_at) if camera else None,
                    "crashes": crashes,
                    "suspect_sightings": sightings,
                    "confirmed_count": db.scalar(
                        select(func.count()).select_from(Sighting).where(
                            Sighting.junction_id == junction.id, Sighting.plate.is_not(None)
                        )
                    ) or 0,
                }
            )
        return {"items": items, "total": len(items)}

    @application.get("/api/cameras/status")
    async def camera_status(
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        cameras = db.scalars(select(LiveCamera).order_by(LiveCamera.junction_id)).all()
        now = utcnow()
        return {
            "items": [
                {
                    "id": camera.id,
                    "junction_id": camera.junction_id,
                    "status": _camera_state(camera, now),
                    "last_frame_at": iso(camera.last_frame_at),
                    "snapshot_url": f"/api/cameras/{camera.id}/snapshot" if camera.latest_frame_path else None,
                }
                for camera in cameras
            ],
            "total": len(cameras),
        }

    @application.get("/api/cameras/{camera_id}/snapshot")
    async def camera_snapshot(
        camera_id: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ):
        camera = db.get(LiveCamera, camera_id)
        if camera is None:
            raise HTTPException(status_code=404, detail="Camera not found.")
        return serve_media(camera.latest_frame_path)

    @application.get("/api/incidents")
    async def incidents_list(
        status: str | None = None,
        limit: int = Query(default=100, ge=1, le=500),
        offset: int = Query(default=0, ge=0),
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = select(Incident)
        if status and status.lower() in {"resolved", "unresolved"}:
            query = query.where(Incident.status == status.lower())
        total = db.scalar(select(func.count()).select_from(query.subquery())) or 0
        incidents = db.scalars(query.order_by(Incident.occurred_at.desc()).offset(offset).limit(limit)).all()
        return list_response([public_incident(item) for item in incidents], total, limit, offset)

    @application.get("/api/incidents/board")
    async def incidents_board(
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        unresolved = db.scalars(select(Incident).where(Incident.status == "unresolved").order_by(Incident.occurred_at.desc())).all()
        today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        resolved_today = db.scalars(
            select(Incident).where(Incident.status == "resolved", Incident.resolved_at >= today_start).order_by(Incident.resolved_at.desc())
        ).all()
        return {
            "unresolved": [public_incident(item) for item in unresolved],
            "resolved_today": [public_incident(item) for item in resolved_today],
            "updated_at": iso(utcnow()),
        }

    def authority_incident_or_404(incident_id: str, db: Session) -> Incident:
        incident = db.get(Incident, incident_id)
        if incident is None:
            raise HTTPException(status_code=404, detail="Incident not found.")
        return incident

    @application.get("/api/incidents/{incident_id}")
    async def incident_detail(
        incident_id: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        incident = authority_incident_or_404(incident_id, db)
        tags = db.scalars(select(IncidentTag).where(IncidentTag.incident_id == incident.id)).all()
        sightings = db.scalars(select(Sighting).where(Sighting.incident_id == incident.id).order_by(Sighting.seen_at)).all()
        result = public_incident(incident)
        result["crash_zone_rfid_snapshot"] = [
            {
                "epc": tag.epc,
                "plate": tag.plate or "UNREGISTERED_TAG",
                "junction_id": tag.crash_junction,
                "peak_rssi": float(tag.peak_rssi) if tag.peak_rssi is not None else None,
                "reports": tag.report_count,
                "added_at": iso(tag.added_at),
            }
            for tag in tags
        ]
        confirmations = db.scalars(
            select(IncidentResponse).where(IncidentResponse.incident_id == incident.id)
        ).all()
        result["citizen_confirmations"] = {
            "responses": len(confirmations),
            "accident_confirmed": sum(1 for item in confirmations if item.accident_occurred),
            "false_alarm_reported": sum(1 for item in confirmations if not item.accident_occurred),
        }
        result["sightings"] = [
            {
                "id": sighting.id,
                "junction_id": sighting.junction_id,
                "plate": sighting.plate,
                "seen_at": iso(sighting.seen_at),
                "vision_verification": "pending" if sighting.plate is None else "plate_resolved",
                "payload": json.loads(sighting.payload_json),
            }
            for sighting in sightings
        ]
        result["evidence"] = [{"id": "latest", "url": f"/api/incidents/{incident.id}/evidence/latest"}] if incident.evidence_path else []
        return result

    @application.get("/api/incidents/{incident_id}/tracks")
    async def incident_tracks(
        incident_id: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        incident = authority_incident_or_404(incident_id, db)
        sightings = db.scalars(
            select(Sighting).where(Sighting.incident_id == incident.id).order_by(Sighting.seen_at)
        ).all()
        return {
            "incident_id": incident.id,
            "tracks": [
                {
                    "epc": sighting.epc,
                    "plate": sighting.plate,
                    "junction_id": sighting.junction_id,
                    "seen_at": iso(sighting.seen_at),
                }
                for sighting in sightings
            ],
        }

    @application.get("/api/incidents/{incident_id}/evidence/{evidence_id}")
    @application.get("/api/incidents/{incident_id}/evidence/latest")
    async def incident_evidence(
        incident_id: str,
        evidence_id: str = "latest",
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ):
        del evidence_id
        incident = authority_incident_or_404(incident_id, db)
        return serve_media(incident.evidence_path)

    @application.post("/api/incidents/{incident_id}/resolve")
    async def resolve_incident(
        incident_id: str,
        request: ResolveIncidentRequest,
        user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        if not verify_password(request.password, user.password_hash):
            raise HTTPException(status_code=401, detail="Password confirmation failed.")
        incident = authority_incident_or_404(incident_id, db)
        if incident.status == "unresolved":
            incident.status = "resolved"
            incident.resolved_by = user.id
            incident.resolved_at = utcnow()
            db.commit()
        return {
            "incident_id": incident.id,
            "status": incident.status,
            "resolved_at": iso(incident.resolved_at),
        }

    @application.get("/api/rfid/health")
    async def rfid_health(
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        latest = db.scalar(select(func.max(RFIDRead.read_at)))
        return {
            "status": "online" if latest and (utcnow() - (latest.replace(tzinfo=timezone.utc) if latest.tzinfo is None else latest)).total_seconds() <= 60 else "offline",
            "last_report_at": iso(latest),
        }

    @application.get("/api/streams")
    async def streams(
        _user: User = Depends(require_roles("authority", "admin")),
    ) -> dict[str, Any]:
        configured = bool(os.getenv("MEDIAMTX_WHEP_BASE_URL"))
        return {
            "items": [],
            "ice_servers": [],
            "status": "configured" if configured else "unavailable",
            "message": None if configured else "MediaMTX WHEP is not configured.",
        }

    @application.post("/api/routine-violations/detect", status_code=202)
    async def upload_routine_video(
        file: UploadFile = File(...),
        user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        filename = Path(file.filename or "traffic-video").name
        if not filename or Path(filename).suffix.lower() not in {".mp4", ".mov", ".avi", ".mkv", ".webm"}:
            raise HTTPException(status_code=415, detail="Upload a supported traffic video file.")
        size = 0
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_VIDEO_BYTES:
                raise HTTPException(status_code=413, detail="Video exceeds the configured upload limit.")
        job = RoutineJob(
            submitted_by=user.id,
            filename=filename,
            status="failed",
            result_json=json.dumps({"violations": [], "unmatched_violations": [], "pending_verification": []}),
            error_message="Routine-violation inference is not configured. Connect the YOLO/ANPR processing service to analyze videos.",
        )
        db.add(job)
        db.commit()
        return {
            "job_id": job.id,
            "status": job.status,
            "message": job.error_message,
        }

    @application.get("/api/routine-violations/jobs/{job_id}")
    async def routine_job(
        job_id: str,
        user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        job = db.get(RoutineJob, job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Video job not found.")
        if job.submitted_by != user.id and user.role != "admin":
            raise HTTPException(status_code=404, detail="Video job not found.")
        return {
            "job_id": job.id,
            "status": job.status,
            "filename": job.filename,
            "created_at": iso(job.created_at),
            "result": json.loads(job.result_json) if job.result_json else None,
            "error": job.error_message,
        }

    @application.get("/api/authority/vehicles")
    async def search_vehicles(
        q: str = Query(default="", max_length=120),
        limit: int = Query(default=100, ge=1, le=500),
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        query = select(Vehicle)
        if q.strip():
            term = f"%{q.strip().upper()}%"
            query = query.where(or_(Vehicle.plate.ilike(term), Vehicle.fastag_id.ilike(term)))
        vehicles = db.scalars(query.order_by(Vehicle.plate).limit(limit)).all()
        items = []
        for vehicle in vehicles:
            item = public_vehicle(vehicle)
            owner = db.get(User, vehicle.owner_id) if vehicle.owner_id else None
            item["owner"] = {"name": owner.name, "email": owner.email} if owner else None
            items.append(item)
        return {"items": items, "total": len(items)}

    @application.get("/api/authority/vehicles/{plate}")
    async def vehicle_profile(
        plate: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        normalized = plate_value(plate)
        vehicle = db.scalar(select(Vehicle).where(Vehicle.plate == normalized))
        if vehicle is None:
            raise HTTPException(status_code=404, detail="Vehicle not found.")
        owner = db.get(User, vehicle.owner_id) if vehicle.owner_id else None
        sightings = db.scalars(select(Sighting).where(Sighting.plate == vehicle.plate).order_by(Sighting.seen_at)).all()
        return {
            **public_vehicle(vehicle),
            "owner": {"name": owner.name, "email": owner.email} if owner else None,
            "sightings": [
                {"incident_id": sighting.incident_id, "junction_id": sighting.junction_id, "seen_at": iso(sighting.seen_at)}
                for sighting in sightings
            ],
        }

    @application.get("/api/authority/vehicles/{plate}/tracks")
    async def vehicle_tracks(
        plate: str,
        _user: User = Depends(require_roles("authority", "admin")),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        normalized = plate_value(plate)
        vehicle = db.scalar(select(Vehicle).where(Vehicle.plate == normalized))
        if vehicle is None:
            raise HTTPException(status_code=404, detail="Vehicle not found.")
        sightings = db.scalars(select(Sighting).where(Sighting.plate == normalized).order_by(Sighting.seen_at)).all()
        return {"plate_number": normalized, "items": [
            {"incident_id": item.incident_id, "junction_id": item.junction_id, "seen_at": iso(item.seen_at)}
            for item in sightings
        ]}

    def require_internal_token(token: str | None) -> None:
        expected = os.getenv("VISION_SHARED_SECRET", "")
        if not expected:
            raise HTTPException(status_code=503, detail="Internal vision integration is not configured.")
        if token is None or not hmac.compare_digest(token, expected):
            raise HTTPException(status_code=401, detail="Internal service authentication failed.")

    @application.post("/api/internal/vehicles", status_code=201)
    async def upsert_vehicle(
        request: VehicleRegistryRequest,
        token: str | None = Header(default=None, alias="X-Internal-Token"),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        require_internal_token(token)
        plate = plate_value(request.plate)
        if not plate:
            raise HTTPException(status_code=422, detail="Vehicle registration number is required.")
        vehicle = db.scalar(select(Vehicle).where(Vehicle.plate == plate))
        if vehicle is None:
            vehicle = Vehicle(plate=plate)
            db.add(vehicle)
        vehicle.fastag_id = request.fastag_id.strip() if request.fastag_id else None
        vehicle.make = request.make
        vehicle.model = request.model
        vehicle.year = request.year
        vehicle.colour = request.colour
        vehicle.vehicle_type = request.vehicle_type
        vehicle.state = request.state
        try:
            db.commit()
        except IntegrityError as error:
            db.rollback()
            raise HTTPException(status_code=409, detail="FASTag ID is already associated with another vehicle.") from error
        return public_vehicle(vehicle)

    @application.post("/api/internal/violations", status_code=201)
    async def ingest_violation(
        request: ViolationEvent,
        token: str | None = Header(default=None, alias="X-Internal-Token"),
        db: Session = Depends(get_db),
    ) -> dict[str, Any]:
        require_internal_token(token)
        violation_type = request.violation_type.strip().upper()
        if violation_type not in FINE_AMOUNTS:
            raise HTTPException(status_code=422, detail="Only NO HELMET and TRIPLE RIDING fines are configured.")
        plate = plate_value(request.plate)
        if request.plate_status != "confirmed" or not plate:
            if request.pattern:
                pattern = request.pattern.strip().upper()
                existing = db.scalar(
                    select(PendingVerification).where(
                        PendingVerification.run_id == request.run_id,
                        PendingVerification.pattern == pattern,
                        PendingVerification.status == "pending",
                    )
                )
                if existing is None:
                    registered = db.scalars(select(Vehicle.plate)).all()
                    compact_pattern = re.sub(r"\s+", "", pattern)
                    regex = re.compile("^" + re.escape(compact_pattern).replace("_", ".") + "$")
                    candidates = [registered_plate for registered_plate in registered if regex.fullmatch(registered_plate)]
                    existing = PendingVerification(
                        run_id=request.run_id,
                        pattern=pattern,
                        candidate_plates_json=json.dumps(candidates),
                    )
                    db.add(existing)
                    db.commit()
                await broadcast({"type": "pending_verification", "id": existing.id, "pattern": existing.pattern})
                return {"status": "pending_verification", "id": existing.id, "pattern": existing.pattern}
            return {"status": "unmatched", "reason": "Plate is unreadable or unconfirmed; no fine was created."}
        vehicle = db.scalar(select(Vehicle).where(Vehicle.plate == plate))
        if vehicle is None or vehicle.owner_id is None:
            return {"status": "unmatched", "plate": plate, "reason": "No registered citizen owner; no fine was created."}
        existing_fine = db.scalar(
            select(Fine).where(
                Fine.run_id == request.run_id,
                Fine.plate == plate,
                Fine.violation_type == violation_type,
            )
        )
        if existing_fine:
            return {"status": "duplicate", "fine": public_fine(existing_fine)}
        evidence_path = (
            _persist_image(request.evidence_image_base64, f"fine-{uuid4()}")
            if request.evidence_image_base64
            else None
        )
        fine = Fine(
            challan_number=f"KA-{datetime.now(timezone.utc):%Y%m%d}-{secrets.token_hex(4).upper()}",
            vehicle_id=vehicle.id,
            plate=plate,
            violation_type=violation_type,
            amount=FINE_AMOUNTS[violation_type],
            issued_at=request.timestamp or utcnow(),
            plate_status="confirmed",
            status="unpaid",
            run_id=request.run_id,
            evidence_path=evidence_path,
        )
        db.add(fine)
        db.flush()
        notification = Notification(
            user_id=vehicle.owner_id,
            kind="fine_issued",
            message=f"A {violation_type} fine was issued to vehicle {plate}.",
            fine_id=fine.id,
        )
        db.add(notification)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing_fine = db.scalar(
                select(Fine).where(
                    Fine.run_id == request.run_id,
                    Fine.plate == plate,
                    Fine.violation_type == violation_type,
                )
            )
            if existing_fine is None:
                raise
            return {"status": "duplicate", "fine": public_fine(existing_fine)}
        await broadcast({"type": "fine_issued", "fine": public_fine(fine)})
        await notify_citizen(
            vehicle.owner_id,
            {
                "type": "fine_issued",
                "fine": public_fine(fine),
                "notification": public_notification(notification),
            },
        )
        return {"status": "issued", "fine": public_fine(fine)}

    @application.get("/evidence/{file_name}")
    async def evidence_file(
        file_name: str,
        _user: User = Depends(current_user),
    ):
        if Path(file_name).name != file_name or file_name in {".", ".."}:
            raise HTTPException(status_code=404, detail="Evidence file not found.")
        return serve_media((Path("evidence") / file_name).as_posix())

    @application.get("/runs/{run_id}/{file_name}")
    async def run_file(
        run_id: str,
        file_name: str,
        _user: User = Depends(require_roles("authority", "admin")),
    ):
        if Path(run_id).name != run_id or Path(file_name).name != file_name:
            raise HTTPException(status_code=404, detail="Run file not found.")
        raise HTTPException(status_code=404, detail="No routine-violation run artifact is available.")

    @application.websocket("/ws/live-cameras")
    async def live_cameras(websocket: WebSocket) -> None:
        authorization = websocket.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        claims = decode_access_token(token) if scheme.lower() == "bearer" else None
        if claims is None:
            await websocket.close(code=1008, reason="Bearer authentication required.")
            return
        with factory() as db:
            user = db.get(User, str(claims["sub"]))
            revoked = db.get(RevokedToken, str(claims["jti"])) is not None
        if user is None or user.status != "active" or user.role not in {"authority", "admin"} or revoked:
            await websocket.close(code=1008, reason="Authority access required.")
            return
        await websocket.accept()
        async with application.state.socket_lock:
            application.state.authority_sockets.add(websocket)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            async with application.state.socket_lock:
                application.state.authority_sockets.discard(websocket)

    @application.websocket("/ws/citizen/alerts")
    async def citizen_alerts(websocket: WebSocket) -> None:
        authorization = websocket.headers.get("authorization", "")
        scheme, _, token = authorization.partition(" ")
        claims = decode_access_token(token) if scheme.lower() == "bearer" else None
        if claims is None:
            await websocket.close(code=1008, reason="Bearer authentication required.")
            return
        with factory() as db:
            user = db.get(User, str(claims["sub"]))
            revoked = db.get(RevokedToken, str(claims["jti"])) is not None
        if user is None or user.status != "active" or user.role != "citizen" or revoked:
            await websocket.close(code=1008, reason="Citizen access required.")
            return
        await websocket.accept()
        entry = (websocket, user.id)
        async with application.state.socket_lock:
            application.state.citizen_sockets.add(entry)
        try:
            while True:
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            async with application.state.socket_lock:
                application.state.citizen_sockets.discard(entry)

    async def handle_rfid_event(event: dict[str, Any], db: Session) -> None:
        epc = str(event.get("epc") or event.get("tag_id") or "").strip()
        junction_id = str(event.get("junction_id") or event.get("junction") or "").strip()
        if not epc or not junction_id:
            raise ValueError("RFID event requires epc and junction_id.")
        safe_event = {
            key: value
            for key, value in event.items()
            if "base64" not in key.lower() and key.lower() not in {"jpeg", "frame"}
        }
        read_at = parse_datetime(event.get("event_time") or event.get("timestamp"))
        rssi = event.get("rssi")
        reading = RFIDRead(
            epc=epc,
            junction_id=junction_id,
            rssi=float(rssi) if isinstance(rssi, (int, float)) else None,
            read_at=read_at,
            window_start=parse_datetime(event["window_start"]) if event.get("window_start") else None,
            window_end=parse_datetime(event["window_end"]) if event.get("window_end") else None,
        )
        db.add(reading)
        tags = db.scalars(select(IncidentTag).where(IncidentTag.epc == epc)).all()
        published: list[dict[str, Any]] = []
        for tag in tags:
            if junction_id == tag.crash_junction or read_at <= utc_aware(tag.added_at):
                continue
            existing = db.scalar(
                select(Sighting).where(
                    Sighting.incident_id == tag.incident_id,
                    Sighting.epc == epc,
                    Sighting.junction_id == junction_id,
                )
            )
            if existing:
                continue
            sighting = Sighting(
                incident_id=tag.incident_id,
                epc=epc,
                junction_id=junction_id,
                plate=tag.plate,
                seen_at=read_at,
                payload_json=json.dumps(safe_event, separators=(",", ":"), default=str),
            )
            db.add(sighting)
            published.append(
                {
                    "type": "watchlist_rfid_hit",
                    "incident_id": tag.incident_id,
                    "epc": epc,
                    "plate": tag.plate or "UNREGISTERED_TAG",
                    "junction_id": junction_id,
                    "seen_at": iso(read_at),
                    "vision_verification": "pending",
                }
            )
        db.commit()
        for item in published:
            await broadcast(item)

    async def handle_crash_event(event: dict[str, Any], db: Session) -> dict[str, Any]:
        event_id_value = event.get("alert_id") or event.get("event_id") or event.get("id")
        run_id = str(event.get("run_id") or event.get("scenario_id") or "unknown")
        junction_id = str(event.get("junction_id") or event.get("junction") or "")
        if not event_id_value or not junction_id:
            raise ValueError("Crash alert requires alert_id/event_id, run_id, and junction_id.")
        event_id = f"{run_id}:{event_id_value}"
        existing = db.scalar(select(Incident).where(Incident.event_id == event_id))
        if existing:
            return {"type": "crash_alert_ack", "alert_id": str(event_id_value), "incident_id": existing.id, "duplicate": True}

        occurred_at = parse_datetime(event.get("event_time") or event.get("timestamp"))
        plates: list[str] = []
        for key in ("involved_plates", "vehicle_plates", "plates"):
            value = event.get(key)
            if isinstance(value, list):
                for item in value:
                    plate = plate_value(item if isinstance(item, str) else item.get("plate") if isinstance(item, dict) else None)
                    if plate and plate not in plates:
                        plates.append(plate)
        vehicles = event.get("vehicles")
        if isinstance(vehicles, list):
            for vehicle in vehicles:
                if isinstance(vehicle, dict):
                    plate = plate_value(vehicle.get("plate") or vehicle.get("plate_number"))
                    if plate and plate not in plates:
                        plates.append(plate)
        position = event.get("position") if isinstance(event.get("position"), dict) else None
        image = event.get("image_base64") or event.get("jpeg_base64") or event.get("frame_base64")
        safe_event = {
            key: value
            for key, value in event.items()
            if "base64" not in key.lower() and key.lower() not in {"jpeg", "frame"}
        }
        incident = Incident(
            event_id=event_id,
            run_id=run_id,
            junction_id=junction_id,
            occurred_at=occurred_at,
            status="unresolved",
            severity=str(event.get("severity") or event.get("confidence") or "unknown")[:20],
            position_json=json.dumps(position) if position else None,
            involved_plates_json=json.dumps(plates),
            payload_json=json.dumps(event, separators=(",", ":"), default=str),
            evidence_path=_persist_image(image, f"incident-{uuid4()}") if isinstance(image, str) else None,
        )
        db.add(incident)
        db.flush()
        time_start = occurred_at - timedelta(seconds=30)
        time_end = occurred_at + timedelta(seconds=30)
        reads = db.scalars(
            select(RFIDRead).where(
                RFIDRead.junction_id == junction_id,
                RFIDRead.read_at >= time_start,
                RFIDRead.read_at <= time_end,
            )
        ).all()
        for read in reads:
            if db.scalar(
                select(IncidentTag.id).where(
                    IncidentTag.incident_id == incident.id,
                    IncidentTag.epc == read.epc,
                )
            ):
                continue
            vehicle = db.scalar(select(Vehicle).where(Vehicle.fastag_id == read.epc))
            tag = IncidentTag(
                incident_id=incident.id,
                epc=read.epc,
                plate=vehicle.plate if vehicle else None,
                crash_junction=junction_id,
                peak_rssi=read.rssi,
                report_count=sum(1 for report in reads if report.epc == read.epc),
                added_at=occurred_at,
            )
            db.add(tag)
            if vehicle and vehicle.plate not in plates:
                plates.append(vehicle.plate)
                incident.involved_plates_json = json.dumps(plates)
        for plate in plates:
            vehicle = db.scalar(select(Vehicle).where(Vehicle.plate == plate))
            if vehicle and vehicle.owner_id:
                notification = Notification(
                        user_id=vehicle.owner_id,
                        kind="crash_involvement",
                        message=f"Your registered vehicle was involved in a reported crash at {junction_id}.",
                        incident_id=incident.id,
                    )
                db.add(notification)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            existing = db.scalar(select(Incident).where(Incident.event_id == event_id))
            if existing is None:
                raise
            incident = existing
        await broadcast({"type": "crash_alert", **public_incident(incident)})
        await broadcast({"type": "incident_created", **public_incident(incident)})
        for plate in plates:
            vehicle = db.scalar(select(Vehicle).where(Vehicle.plate == plate))
            if vehicle and vehicle.owner_id:
                notification = db.scalar(
                    select(Notification)
                    .where(
                        Notification.user_id == vehicle.owner_id,
                        Notification.incident_id == incident.id,
                        Notification.kind == "crash_involvement",
                    )
                )
                if notification:
                    await notify_citizen(
                        vehicle.owner_id,
                        {
                            "type": "crash_involvement",
                            "incident_id": incident.id,
                            "notification": public_notification(notification),
                            "incident": public_incident(incident, citizen=True),
                        },
                    )
        return {"type": "crash_alert_ack", "alert_id": str(event_id_value), "incident_id": incident.id, "duplicate": False}

    async def handle_vision_event(event: dict[str, Any], db: Session) -> dict[str, Any]:
        event_id = str(event.get("event_id") or event.get("alert_id") or "")
        incident = db.scalar(select(Incident).where(Incident.event_id == event_id)) if event_id else None
        if incident is None and event.get("incident_id"):
            incident = db.get(Incident, str(event["incident_id"]))
        if incident is None:
            raise ValueError("Vision result does not identify a known incident.")
        plate = plate_value(event.get("plate") or event.get("plate_number"))
        epc = str(event.get("epc") or event.get("tag_id") or "")
        sighting = db.scalar(
            select(Sighting).where(Sighting.incident_id == incident.id, Sighting.epc == epc)
        ) if epc else None
        if sighting is None:
            raise ValueError("Vision result does not match a stored RFID sighting.")
        sighting.plate = plate
        sighting.payload_json = json.dumps(event, separators=(",", ":"), default=str)
        db.commit()
        result = {
            "type": "vision_match_result",
            "incident_id": incident.id,
            "sighting_id": sighting.id,
            "epc": epc,
            "plate": plate,
            "status": "confirmed" if plate else "unreadable",
            "raw_ocr": event.get("raw_ocr"),
            "ocr_confidence": event.get("ocr_confidence"),
            "plate_pixel_size": event.get("plate_pixel_size"),
        }
        await broadcast(result)
        return {"type": "vision_match_ack", "incident_id": incident.id, "sighting_id": sighting.id}

    async def handle_carla_event(event: dict[str, Any], db: Session) -> dict[str, Any] | None:
        event_type = str(event.get("type") or event.get("event") or "")
        if event_type in {"crash_alert", "CRASH_DETECTED"}:
            return await handle_crash_event(event, db)
        if event_type in {"rfid_reading", "TAG_REPORT"}:
            await handle_rfid_event(event, db)
            return {"type": "rfid_reading_ack", "epc": event.get("epc") or event.get("tag_id")}
        if event_type == "vision_match_result":
            return await handle_vision_event(event, db)
        if event_type in {"camera_frame", "vehicle_boxes", "vehicle_state"}:
            junction_id = str(event.get("junction_id") or event.get("junction") or "")
            camera_id = str(event.get("camera_id") or f"CAM-{junction_id}")
            frame = event.get("image_base64") or event.get("jpeg_base64") or event.get("frame_base64")
            if event_type == "camera_frame" and isinstance(frame, str):
                relative = _persist_image(frame, f"camera-{camera_id}-{uuid4()}")
                camera = db.get(LiveCamera, camera_id)
                if camera is None:
                    camera = LiveCamera(id=camera_id, junction_id=junction_id)
                    db.add(camera)
                camera.last_frame_at = parse_datetime(event.get("event_time") or event.get("timestamp"))
                camera.latest_frame_path = relative
                application.state.camera_frames[camera_id] = frame.split(",", 1)[-1]
                db.commit()
            await broadcast(event)
            return None
        if event_type == "pending_verification":
            pattern = str(event.get("pattern") or "").strip()
            if not pattern:
                raise ValueError("Pending-verification event requires a partial plate pattern.")
            row = PendingVerification(
                run_id=str(event.get("run_id") or "unknown"),
                pattern=pattern,
                candidate_plates_json=json.dumps(event.get("candidate_plates") if isinstance(event.get("candidate_plates"), list) else []),
            )
            db.add(row)
            db.commit()
            await broadcast({"type": "pending_verification", "id": row.id, "pattern": row.pattern})
            return {"type": "pending_verification_ack", "id": row.id}
        if event_type == "crash_alert_ack":
            return None
        raise ValueError(f"Unsupported CARLA event type: {event_type or '(missing)'}")

    @application.websocket("/ws/carla/cameras")
    async def carla_camera_ingest(websocket: WebSocket) -> None:
        expected = os.getenv("CARLA_SHARED_SECRET", "")
        authorization = websocket.headers.get("authorization", "")
        scheme, _, supplied = authorization.partition(" ")
        if not expected or scheme.lower() != "bearer" or not hmac.compare_digest(supplied, expected):
            await websocket.close(code=1008, reason="CARLA service authentication failed.")
            return
        await websocket.accept()
        try:
            while True:
                message = await websocket.receive_text()
                try:
                    event = json.loads(message)
                    if not isinstance(event, dict):
                        raise ValueError("WebSocket event must be a JSON object.")
                    with factory() as db:
                        acknowledgement = await handle_carla_event(event, db)
                    if acknowledgement:
                        await websocket.send_json(acknowledgement)
                except (json.JSONDecodeError, ValueError) as error:
                    await websocket.send_json({"type": "error", "detail": str(error)})
                except Exception:
                    logger.exception("Failed to process CARLA event.")
                    await websocket.send_json({"type": "error", "detail": "Backend failed to process event."})
        except WebSocketDisconnect:
            logger.info("CARLA camera event socket disconnected.")

    return application


app = create_app()
