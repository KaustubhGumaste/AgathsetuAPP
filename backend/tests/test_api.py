from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine

from backend.main import create_app
from backend.models import User
from backend.security import hash_password


@pytest.fixture
def api(tmp_path, monkeypatch):
    monkeypatch.setenv("CARLA_SHARED_SECRET", "test-carla-service-secret")
    monkeypatch.setenv("VISION_SHARED_SECRET", "test-vision-service-secret")
    test_engine = create_engine(f"sqlite:///{(tmp_path / 'test.db').as_posix()}", connect_args={"check_same_thread": False})
    application = create_app(test_engine)
    with TestClient(application) as client:
        with application.state.session_factory() as db:
            db.add(
                User(
                    name="Test Admin",
                    email="admin@test.example",
                    password_hash=hash_password("a-unique-admin-password"),
                    role="admin",
                    status="active",
                )
            )
            db.commit()
        yield client, application
    test_engine.dispose()


def login(client: TestClient, email: str, password: str) -> dict[str, str]:
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


def test_registration_approval_and_role_boundaries(api):
    client, _application = api
    citizen = client.post(
        "/api/auth/register/citizen",
        json={
            "name": "Aarav Sharma",
            "email": "aarav@example.com",
            "mobile": "+919876543210",
            "password": "safe-citizen-password",
            "vehicle_registration_number": "KA 01 AB 1234",
        },
    )
    assert citizen.status_code == 201, citizen.text
    citizen_headers = login(client, "aarav@example.com", "safe-citizen-password")
    profile = client.get("/api/auth/me", headers=citizen_headers)
    assert profile.status_code == 200
    assert profile.json()["role"] == "citizen"
    assert profile.json()["vehicles"][0]["plate_number"] == "KA01AB1234"
    assert client.get("/api/authority/summary", headers=citizen_headers).status_code == 403

    authority = client.post(
        "/api/auth/register/authority",
        json={
            "name": "Inspector Vikram",
            "email": "inspector@example.gov.in",
            "badge_number": "BLR-1001",
            "jurisdiction": "Bengaluru",
            "password": "safe-authority-password",
        },
    )
    assert authority.status_code == 201
    pending_login = client.post(
        "/api/auth/login",
        json={"email": "inspector@example.gov.in", "password": "safe-authority-password"},
    )
    assert pending_login.status_code == 403

    admin_headers = login(client, "admin@test.example", "a-unique-admin-password")
    pending_accounts = client.get("/api/admin/authority-accounts", headers=admin_headers)
    authority_id = pending_accounts.json()["items"][0]["id"]
    approved = client.post(f"/api/admin/authority-accounts/{authority_id}/approve", headers=admin_headers)
    assert approved.status_code == 200
    authority_headers = login(client, "inspector@example.gov.in", "safe-authority-password")
    assert client.get("/api/authority/summary", headers=authority_headers).status_code == 200
    assert client.get("/api/citizen/fines", headers=authority_headers).status_code == 403


def test_crash_alert_idempotency_rfid_and_citizen_confirmation(api):
    client, _application = api
    citizen = client.post(
        "/api/auth/register/citizen",
        json={
            "name": "Aarav Sharma",
            "email": "aarav@example.com",
            "mobile": "+919876543210",
            "password": "safe-citizen-password",
            "vehicle_registration_number": "KA01AB1234",
        },
    )
    assert citizen.status_code == 201
    citizen_headers = login(client, "aarav@example.com", "safe-citizen-password")
    admin_headers = login(client, "admin@test.example", "a-unique-admin-password")
    authority_id = client.post(
        "/api/auth/register/authority",
        json={
            "name": "Inspector",
            "email": "inspector@example.gov.in",
            "badge_number": "BLR-1001",
            "jurisdiction": "Bengaluru",
            "password": "safe-authority-password",
        },
    ).json()["user"]["id"]
    client.post(f"/api/admin/authority-accounts/{authority_id}/approve", headers=admin_headers)
    authority_headers = login(client, "inspector@example.gov.in", "safe-authority-password")
    vehicle = client.post(
        "/api/internal/vehicles",
        headers={"X-Internal-Token": "test-vision-service-secret"},
        json={"plate": "KA01AB1234", "fastag_id": "EPC-TEST-123"},
    )
    assert vehicle.status_code == 201

    crash_time = datetime.now(timezone.utc)
    with client.websocket_connect("/ws/carla/cameras", headers={"Authorization": "Bearer test-carla-service-secret"}) as socket:
        socket.send_json(
            {
                "type": "rfid_reading",
                "epc": "EPC-TEST-123",
                "junction_id": "J01",
                "rssi": -45,
                "timestamp": crash_time.isoformat(),
            }
        )
        assert socket.receive_json()["type"] == "rfid_reading_ack"
        alert = {
            "type": "crash_alert",
            "alert_id": "alert-1",
            "run_id": "run-1",
            "junction_id": "J01",
            "event_time": crash_time.isoformat(),
            "involved_plates": ["KA01AB1234"],
            "position": {"x": 10, "y": 20},
        }
        socket.send_json(alert)
        first_ack = socket.receive_json()
        socket.send_json(alert)
        second_ack = socket.receive_json()
        assert first_ack["duplicate"] is False
        assert second_ack["duplicate"] is True
        assert first_ack["incident_id"] == second_ack["incident_id"]

        socket.send_json(
            {
                "type": "rfid_reading",
                "epc": "EPC-TEST-123",
                "junction_id": "J02",
                "rssi": -52,
                "timestamp": (crash_time + timedelta(seconds=10)).isoformat(),
            }
        )
        assert socket.receive_json()["type"] == "rfid_reading_ack"

    incident_id = first_ack["incident_id"]
    incident_response = client.get(f"/api/citizen/incidents/{incident_id}", headers=citizen_headers)
    assert incident_response.status_code == 200
    assert "evidence" not in incident_response.json()
    assert "timeline" not in incident_response.json()
    assert incident_response.json()["vehicle_count"] == 1
    assert incident_response.json()["response"] is None
    confirmation = client.post(
        f"/api/citizen/incidents/{incident_id}/confirm",
        headers=citizen_headers,
        json={"accident_occurred": False},
    )
    assert confirmation.status_code == 200
    assert confirmation.json()["accident_occurred"] is False
    assert client.get(f"/api/citizen/incidents/{incident_id}", headers=citizen_headers).json()["response"]["accident_occurred"] is False

    authority_detail = client.get(f"/api/incidents/{incident_id}", headers=authority_headers)
    assert authority_detail.status_code == 200
    assert authority_detail.json()["sightings"][0]["junction_id"] == "J02"
    assert authority_detail.json()["crash_zone_rfid_snapshot"][0]["plate"] == "KA01AB1234"


def test_fines_are_owner_scoped_and_payment_is_idempotent(api):
    client, _application = api
    assert client.post(
        "/api/auth/register/citizen",
        json={
            "name": "Aarav Sharma",
            "email": "aarav@example.com",
            "mobile": "+919876543210",
            "password": "safe-citizen-password",
            "vehicle_registration_number": "KA01AB1234",
        },
    ).status_code == 201
    citizen_headers = login(client, "aarav@example.com", "safe-citizen-password")
    issued = client.post(
        "/api/internal/violations",
        headers={"X-Internal-Token": "test-vision-service-secret"},
        json={"run_id": "run-10", "plate": "KA01AB1234", "violation_type": "NO HELMET"},
    )
    assert issued.status_code == 201, issued.text
    fine = issued.json()["fine"]
    assert fine["amount"] == 1000
    assert fine["status"] == "unpaid"
    paid = client.post(
        f"/api/citizen/fines/{fine['id']}/pay",
        headers=citizen_headers,
        json={"method": "upi"},
    )
    assert paid.status_code == 200
    assert paid.json()["payment"]["receipt_number"].startswith("AGH-")
    assert paid.json()["fine"]["status"] == "paid"
    duplicate = client.post(
        f"/api/citizen/fines/{fine['id']}/pay",
        headers=citizen_headers,
        json={"method": "upi"},
    )
    assert duplicate.status_code == 409
    payments = client.get("/api/citizen/payments", headers=citizen_headers)
    assert payments.json()["total"] == 1


def test_auth_required_for_private_routes(api):
    client, _application = api
    assert client.get("/api/incidents").status_code == 401
    assert client.get("/api/citizen/fines").status_code == 401
    assert client.get("/health").json()["status"] == "ok"
