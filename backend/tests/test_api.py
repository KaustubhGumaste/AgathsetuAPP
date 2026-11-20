import base64
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from starlette.websockets import WebSocketDisconnect

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


def test_super_admin_can_access_admin_and_authority_features(api):
    client, application = api
    with application.state.session_factory() as db:
        db.add(
            User(
                name="Test Super Admin",
                email="superadmin@test.example",
                password_hash=hash_password("a-unique-super-admin-password"),
                role="super_admin",
                status="active",
            )
        )
        db.commit()

    headers = login(client, "superadmin@test.example", "a-unique-super-admin-password")
    assert client.get("/api/admin/authority-accounts", headers=headers).status_code == 200
    assert client.get("/api/authority/summary", headers=headers).status_code == 200
    assert client.get("/api/cameras/status", headers=headers).status_code == 200


def test_live_camera_websocket_ticket_is_single_use(api):
    client, _application = api
    access_token = client.post(
        "/api/auth/login",
        json={"email": "admin@test.example", "password": "a-unique-admin-password"},
    ).json()["access_token"]
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/live-cameras?ticket={access_token}"):
            pass

    headers = {"Authorization": f"Bearer {access_token}"}
    response = client.post("/api/auth/websocket-ticket", headers=headers)
    assert response.status_code == 200, response.text
    ticket = response.json()["ticket"]
    socket_url = f"/ws/live-cameras?ticket={ticket}"

    with client.websocket_connect(socket_url):
        pass

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(socket_url):
            pass


def test_carla_camera_frame_is_broadcast_and_online(api, tmp_path, monkeypatch):
    client, _application = api
    monkeypatch.setattr("backend.main.MEDIA_ROOT", tmp_path / "media")
    headers = login(client, "admin@test.example", "a-unique-admin-password")
    ticket = client.post("/api/auth/websocket-ticket", headers=headers).json()["ticket"]
    jpeg = base64.b64encode(b"\xff\xd8\xff\xd9").decode("ascii")

    with client.websocket_connect(f"/ws/live-cameras?ticket={ticket}") as live_socket:
        with client.websocket_connect(
            "/ws/carla/cameras",
            headers={"Authorization": "Bearer test-carla-service-secret"},
        ) as carla_socket:
            carla_socket.send_json(
                {
                    "type": "camera_frame",
                    "camera_id": "CAM-J01",
                    "junction_id": "J01",
                    "image_base64": jpeg,
                }
            )

            frame_event = live_socket.receive_json()
            assert frame_event["type"] == "camera_frame"
            assert frame_event["junction_id"] == "J01"
            assert frame_event["image_base64"] == jpeg

    status = client.get("/api/cameras/status", headers=headers)
    assert status.status_code == 200
    camera = status.json()["items"][0]
    assert camera["id"] == "CAM-J01"
    assert camera["junction_id"] == "J01"
    assert camera["status"] == "online"
    assert camera["snapshot_url"] == "/api/cameras/CAM-J01/snapshot"


def test_registration_accepts_eight_character_passwords_and_rejects_shorter(api):
    client, _application = api
    citizen = {
        "name": "Aarav Sharma",
        "email": "aarav@example.com",
        "mobile": "+919876543210",
        "password": "pass1234",
        "vehicle_registration_number": "KA01AB1234",
    }
    assert client.post("/api/auth/register/citizen", json=citizen).status_code == 201
    citizen["email"] = "short@example.com"
    citizen["password"] = "pass123"
    assert client.post("/api/auth/register/citizen", json=citizen).status_code == 422

    authority = {
        "name": "Inspector Vikram",
        "email": "inspector@example.gov.in",
        "badge_number": "BLR-1001",
        "jurisdiction": "Bengaluru",
        "password": "pass1234",
    }
    assert client.post("/api/auth/register/authority", json=authority).status_code == 201
    authority["email"] = "short-inspector@example.gov.in"
    authority["password"] = "pass123"
    assert client.post("/api/auth/register/authority", json=authority).status_code == 422


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


def test_citizen_alert_socket_accepts_ticket_and_receives_crash(api):
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
    ticket = client.post("/api/auth/websocket-ticket", headers=citizen_headers)
    assert ticket.status_code == 200, ticket.text

    # A citizen ticket must not open the authority camera feed.
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/live-cameras?ticket={ticket.json()['ticket']}"):
            pass

    ticket = client.post("/api/auth/websocket-ticket", headers=citizen_headers).json()["ticket"]
    with client.websocket_connect(f"/ws/citizen/alerts?ticket={ticket}") as alerts:
        with client.websocket_connect("/ws/carla/cameras", headers={"Authorization": "Bearer test-carla-service-secret"}) as carla:
            carla.send_json(
                {
                    "type": "crash_alert",
                    "alert_id": "alert-socket",
                    "run_id": "run-socket",
                    "junction_id": "J02",
                    "involved_plates": ["KA01AB1234"],
                }
            )
            assert carla.receive_json()["duplicate"] is False
        event = alerts.receive_json()
        assert event["type"] == "crash_involvement"
        assert event["incident_id"]
        assert event["notification"]["kind"] == "crash_involvement"



def test_live_camera_socket_accepts_web_portal_token(api):
    client, _application = api
    access_token = client.post(
        "/api/auth/login",
        json={"email": "admin@test.example", "password": "a-unique-admin-password"},
    ).json()["access_token"]
    with client.websocket_connect(f"/ws/live-cameras?token={access_token}"):
        pass
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/live-cameras?token=not-a-valid-token"):
            pass
    client.post("/api/auth/logout", headers={"Authorization": f"Bearer {access_token}"})
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect(f"/ws/live-cameras?token={access_token}"):
            pass


def test_streams_report_whep_urls_per_junction(api, monkeypatch):
    client, _application = api
    headers = login(client, "admin@test.example", "a-unique-admin-password")
    disabled = client.get("/api/streams", headers=headers).json()
    assert disabled["enabled"] is False and disabled["streams"] == []
    monkeypatch.setenv("MEDIAMTX_WHEP_BASE_URL", "https://media.example/")
    enabled = client.get("/api/streams", headers=headers).json()
    assert enabled["enabled"] is True
    assert {"junction_id": "J01", "whep_url": "https://media.example/J01/whep"} in enabled["streams"]


def test_incident_junction_evidence(api):
    client, _application = api
    headers = login(client, "admin@test.example", "a-unique-admin-password")
    crash_time = datetime.now(timezone.utc)
    with client.websocket_connect("/ws/carla/cameras", headers={"Authorization": "Bearer test-carla-service-secret"}) as socket:
        socket.send_json({
            "type": "crash_alert",
            "alert_id": "alert-junction",
            "run_id": "run-j",
            "junction_id": "J02",
            "event_time": crash_time.isoformat(),
            "involved_plates": ["KA05XY0001"],
        })
        incident_id = socket.receive_json()["incident_id"]
    crash = client.get(f"/api/incidents/{incident_id}/junctions/j02", headers=headers)
    assert crash.status_code == 200, crash.text
    body = crash.json()
    assert body["junction"]["is_crash"] is True
    assert body["incident"]["resolved"] is False
    other = client.get(f"/api/incidents/{incident_id}/junctions/J03", headers=headers).json()
    assert other["junction"]["is_crash"] is False and other["vehicles"] == []
    assert client.get(f"/api/incidents/{incident_id}/junctions/J99", headers=headers).status_code == 404


def test_signup_requires_emailed_otp_when_mail_is_configured(api, monkeypatch):
    from backend import email_otp

    client, _application = api
    sent: list[tuple[str, str]] = []
    monkeypatch.setenv("SMTP_USERNAME", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password")
    monkeypatch.setattr(email_otp, "send_code", lambda email, code: sent.append((email, code)))
    citizen = {
        "name": "Otp Citizen",
        "email": "otp.citizen@example.com",
        "mobile": "+919876543210",
        "password": "otp-password-1",
        "vehicle_registration_number": "KA09OT1234",
    }
    assert client.get("/api/auth/email-otp/config").json()["required"] is True
    assert client.post("/api/auth/register/citizen", json=citizen).status_code == 403

    assert client.post("/api/auth/email-otp/request", json={"email": "OTP.Citizen@example.com"}).status_code == 202
    assert sent and sent[0][0] == "otp.citizen@example.com" and len(sent[0][1]) == 6
    # Resend is throttled.
    assert client.post("/api/auth/email-otp/request", json={"email": citizen["email"]}).status_code == 429

    code = sent[0][1]
    wrong = "000000" if code != "000000" else "111111"
    bad = client.post("/api/auth/email-otp/verify", json={"email": citizen["email"], "code": wrong})
    assert bad.status_code == 400 and "4 attempt" in bad.json()["detail"]
    ok = client.post("/api/auth/email-otp/verify", json={"email": citizen["email"], "code": code})
    assert ok.status_code == 200, ok.text
    token = ok.json()["verification_token"]
    # A code works once.
    assert client.post("/api/auth/email-otp/verify", json={"email": citizen["email"], "code": code}).status_code == 400

    # The verification token is bound to its email address.
    other = {**citizen, "email": "someone.else@example.com", "vehicle_registration_number": "KA09OT9999", "email_verification_token": token}
    assert client.post("/api/auth/register/citizen", json=other).status_code == 403
    created = client.post("/api/auth/register/citizen", json={**citizen, "email_verification_token": token})
    assert created.status_code == 201, created.text
    # Existing accounts cannot request signup codes.
    assert client.post("/api/auth/email-otp/request", json={"email": citizen["email"]}).status_code == 409


def test_otp_locks_after_five_wrong_codes(api, monkeypatch):
    from backend import email_otp

    client, _application = api
    sent: list[tuple[str, str]] = []
    monkeypatch.setenv("SMTP_USERNAME", "sender@example.com")
    monkeypatch.setenv("SMTP_PASSWORD", "app-password")
    monkeypatch.setattr(email_otp, "send_code", lambda email, code: sent.append((email, code)))
    email = "locked@example.com"
    client.post("/api/auth/email-otp/request", json={"email": email})
    code = sent[0][1]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        client.post("/api/auth/email-otp/verify", json={"email": email, "code": wrong})
    assert client.post("/api/auth/email-otp/verify", json={"email": email, "code": code}).status_code == 400


def test_signup_without_mail_configured_needs_no_otp(api, monkeypatch):
    client, _application = api
    monkeypatch.delenv("SMTP_USERNAME", raising=False)
    monkeypatch.delenv("SMTP_PASSWORD", raising=False)
    assert client.get("/api/auth/email-otp/config").json()["required"] is False
    assert client.post("/api/auth/email-otp/request", json={"email": "x@example.com"}).status_code == 503


def test_download_page_and_apk(api, tmp_path, monkeypatch):
    client, _application = api
    page = client.get("/download")
    assert page.status_code == 200 and "AGHAT SETHU" in page.text
    assert client.get("/download/aghat-sethu.apk").status_code in (200, 404)


def register_citizen(client: TestClient, email: str = "aarav@example.com", plate: str = "KA01AB1234") -> dict[str, str]:
    response = client.post(
        "/api/auth/register/citizen",
        json={
            "name": "Aarav Sharma",
            "email": email,
            "mobile": "+919876543210",
            "password": "safe-citizen-password",
            "vehicle_registration_number": plate,
        },
    )
    assert response.status_code == 201, response.text
    return login(client, email, "safe-citizen-password")


def send_crash(client: TestClient, alert_id: str, plates: list[str], **extra) -> str:
    with client.websocket_connect("/ws/carla/cameras", headers={"Authorization": "Bearer test-carla-service-secret"}) as carla:
        carla.send_json({"type": "crash_alert", "alert_id": alert_id, "run_id": "run-map", "junction_id": "J02", "involved_plates": plates, **extra})
        ack = carla.receive_json()
    assert ack["duplicate"] is False
    return ack["incident_id"]


def test_google_sign_in_creates_citizen_and_links_existing_accounts(api, monkeypatch):
    from backend import google_auth

    client, _application = api
    assert client.get("/api/auth/google/config").json() == {"enabled": False}
    monkeypatch.setenv("GOOGLE_CLIENT_IDS", "web-client.apps.googleusercontent.com")
    assert client.get("/api/auth/google/config").json() == {"enabled": True}

    identities = {
        "token-new-citizen-xxxxxxxx": {"email": "Priya@Gmail.com", "email_verified": True, "name": "Priya Rao", "sub": "1"},
        "token-admin-xxxxxxxxxxxxxx": {"email": "admin@test.example", "email_verified": True, "sub": "2"},
        "token-unknown-officer-xxxx": {"email": "nobody@example.gov.in", "email_verified": True, "sub": "3"},
    }

    def fake_verify(token: str):
        if token not in identities:
            raise google_auth.GoogleTokenError("The Google sign-in could not be verified. Try again.")
        return identities[token]

    monkeypatch.setattr(google_auth, "verify_id_token", fake_verify)

    first = client.post("/api/auth/google", json={"id_token": "token-new-citizen-xxxxxxxx", "portal": "citizen"})
    assert first.status_code == 200, first.text
    assert first.json()["created"] is True
    assert first.json()["needs_vehicle"] is True
    headers = {"Authorization": f"Bearer {first.json()['access_token']}"}
    me = client.get("/api/auth/me", headers=headers).json()
    assert me["email"] == "priya@gmail.com" and me["role"] == "citizen" and me["vehicles"] == []

    # Signing in again reuses the account instead of creating another.
    again = client.post("/api/auth/google", json={"id_token": "token-new-citizen-xxxxxxxx"})
    assert again.json()["created"] is False

    added = client.post("/api/citizen/vehicles", json={"vehicle_registration_number": "ka 05 mn 2020"}, headers=headers)
    assert added.status_code == 201, added.text
    assert added.json()["plate_number"] == "KA05MN2020"
    assert client.post("/api/auth/google", json={"id_token": "token-new-citizen-xxxxxxxx"}).json()["needs_vehicle"] is False

    # Someone else's plate cannot be claimed.
    other = register_citizen(client, "other@example.com", "KA09ZZ9999")
    taken = client.post("/api/citizen/vehicles", json={"vehicle_registration_number": "KA05MN2020"}, headers=other)
    assert taken.status_code == 409

    # An existing admin account signs in with Google; it is not turned into a citizen.
    admin = client.post("/api/auth/google", json={"id_token": "token-admin-xxxxxxxxxxxxxx", "portal": "admin"})
    assert admin.status_code == 200 and admin.json()["user"]["role"] == "admin"

    # Officer and admin portals never create accounts.
    unknown = client.post("/api/auth/google", json={"id_token": "token-unknown-officer-xxxx", "portal": "authority"})
    assert unknown.status_code == 404
    bad = client.post("/api/auth/google", json={"id_token": "forged-token-xxxxxxxxxxxxx"})
    assert bad.status_code == 401


def test_incident_location_and_citizen_live_location_reach_authorities(api):
    client, _application = api
    citizen = register_citizen(client)
    stranger = register_citizen(client, "stranger@example.com", "KA09ZZ9999")
    admin = login(client, "admin@test.example", "a-unique-admin-password")

    junction_incident = send_crash(client, "alert-junction", ["KA01AB1234"])
    gps_incident = send_crash(client, "alert-gps", ["KA01AB1234"], latitude=12.97, longitude=77.59)

    board = client.get("/api/incidents/board", headers=admin).json()["unresolved"]
    locations = {item["id"]: item["location"] for item in board}
    assert locations[junction_incident]["source"] == "junction"
    assert locations[gps_incident] == {"latitude": 12.97, "longitude": 77.59, "source": "crash_report", "label": "Junction J02"}

    ticket = client.post("/api/auth/websocket-ticket", headers=admin).json()["ticket"]
    with client.websocket_connect(f"/ws/live-cameras?ticket={ticket}") as live:
        shared = client.post(
            f"/api/citizen/incidents/{junction_incident}/location",
            json={"latitude": 12.9181, "longitude": 77.6241, "accuracy_m": 8},
            headers=citizen,
        )
        assert shared.status_code == 200, shared.text
        event = live.receive_json()
        while event.get("type") != "incident_location":
            event = live.receive_json()
        assert event["incident_id"] == junction_incident
        assert event["latitude"] == 12.9181 and event["name"] == "Aarav Sharma"

    # Updates replace the previous position instead of piling up.
    client.post(f"/api/citizen/incidents/{junction_incident}/location", json={"latitude": 12.919, "longitude": 77.625}, headers=citizen)
    detail = client.get(f"/api/incidents/{junction_incident}/location", headers=admin).json()
    assert len(detail["live_locations"]) == 1
    assert detail["live_locations"][0]["latitude"] == 12.919
    assert detail["live_locations"][0]["stale"] is False
    assert detail["location"]["source"] == "junction"

    # Only people whose vehicle was involved can share, citizens cannot read the responder view, and
    # sharing stops once the incident is resolved.
    assert client.post(f"/api/citizen/incidents/{junction_incident}/location", json={"latitude": 1, "longitude": 1}, headers=stranger).status_code == 404
    assert client.get(f"/api/incidents/{junction_incident}/location", headers=citizen).status_code == 403
    assert client.post(f"/api/citizen/incidents/{junction_incident}/location", json={"latitude": 91, "longitude": 1}, headers=citizen).status_code == 422
    resolved = client.post(f"/api/incidents/{junction_incident}/resolve", json={"password": "a-unique-admin-password", "note": "cleared"}, headers=admin)
    assert resolved.status_code == 200, resolved.text
    assert client.post(f"/api/citizen/incidents/{junction_incident}/location", json={"latitude": 12.9, "longitude": 77.6}, headers=citizen).status_code == 409


def test_incident_route_uses_live_position_and_server_key(api, monkeypatch):
    from backend import google_auth

    client, _application = api
    citizen = register_citizen(client)
    admin = login(client, "admin@test.example", "a-unique-admin-password")
    incident = send_crash(client, "alert-route", ["KA01AB1234"])
    path = f"/api/incidents/{incident}/route?from_lat=12.95&from_lng=77.60"
    assert client.get(path, headers=admin).status_code == 503

    calls = []
    monkeypatch.setenv("GOOGLE_ROUTES_API_KEY", "server-key")
    monkeypatch.setattr(google_auth, "compute_driving_route", lambda origin, destination: calls.append((origin, destination)) or {"encoded_polyline": "abc", "distance_m": 4200, "duration_s": 600})
    first = client.get(path, headers=admin)
    assert first.status_code == 200, first.text
    assert calls[-1] == ((12.95, 77.60), (13.0358, 77.597))  # junction J02 position

    client.post(f"/api/citizen/incidents/{incident}/location", json={"latitude": 13.04, "longitude": 77.6}, headers=citizen)
    second = client.get(path, headers=admin).json()
    assert second["destination"] == {"latitude": 13.04, "longitude": 77.6}
    assert client.get(path, headers=citizen).status_code == 403


def make_officer(client: TestClient, admin: dict[str, str], email: str, center_id: str | None) -> dict[str, str]:
    created = client.post(
        "/api/auth/register/authority",
        json={"name": f"Officer {email[:6]}", "email": email, "badge_number": email[:10], "jurisdiction": "Bengaluru", "password": "safe-officer-password"},
    )
    assert created.status_code == 201, created.text
    pending = client.get("/api/admin/authority-accounts", headers=admin).json()
    user_id = next(item["id"] for item in pending["items"] if item["email"] == email)
    assert client.post(f"/api/admin/authority-accounts/{user_id}/approve", headers=admin).status_code == 200
    headers = login(client, email, "safe-officer-password")
    if center_id:
        assert client.put("/api/authority/me/center", json={"center_id": center_id}, headers=headers).status_code == 200
    return headers


def dispatch_setup(client: TestClient):
    """Centres at about 1, 2, 3, 6, 12 and 40 km north of junction J02 (13.0358, 77.5970)."""
    admin = login(client, "admin@test.example", "a-unique-admin-password")
    km = {"A": 1, "B": 2, "C": 3, "D": 6, "E": 12, "F": 40}
    centers = {}
    for name, distance in km.items():
        response = client.post(
            "/api/admin/centers",
            json={"name": f"Centre {name}", "latitude": 13.0358 + distance / 111.2, "longitude": 77.5970, "phone": "100"},
            headers=admin,
        )
        assert response.status_code == 201, response.text
        centers[name] = response.json()["id"]
    officers = {name: make_officer(client, admin, f"officer{name.lower()}@police.example", centers[name]) for name in km}
    return admin, centers, officers


def dispatch_ids(client: TestClient, headers: dict[str, str]) -> set[str]:
    return {item["id"] for item in client.get("/api/incidents/board?scope=dispatch", headers=headers).json()["unresolved"]}


def test_crash_goes_to_nearest_centres_and_first_acceptance_wins(api, monkeypatch):
    client, _application = api
    citizen = register_citizen(client)
    admin, centers, officers = dispatch_setup(client)

    ticket = client.post("/api/auth/websocket-ticket", headers=officers["A"]).json()["ticket"]
    with client.websocket_connect(f"/ws/live-cameras?ticket={ticket}") as socket_a:
        incident = send_crash(client, "alert-dispatch", ["KA01AB1234"])
        event = socket_a.receive_json()
        while event.get("type") != "crash_alert":
            event = socket_a.receive_json()
    assert event["incident_id"] == incident
    # Nearest three always, then more (up to five) only within 10 km: A, B, C and D. E (12 km) and F stay free.
    offered = {offer["center_name"] for offer in event["dispatch"]["offers"]}
    assert offered == {"Centre A", "Centre B", "Centre C", "Centre D"}
    assert incident in dispatch_ids(client, officers["D"])
    assert incident not in dispatch_ids(client, officers["E"])
    assert incident not in dispatch_ids(client, officers["F"])
    # Far centres cannot take it either.
    assert client.post(f"/api/incidents/{incident}/dispatch/accept", headers=officers["F"]).status_code == 403

    accepted = client.post(f"/api/incidents/{incident}/dispatch/accept", headers=officers["B"])
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["dispatch"]["accepted_center"]["name"] == "Centre B"
    late = client.post(f"/api/incidents/{incident}/dispatch/accept", headers=officers["A"])
    assert late.status_code == 409 and "Centre B" in late.json()["detail"]
    # Other centres' alarms stop; they are free for other crashes.
    assert incident not in dispatch_ids(client, officers["A"])
    board = client.get("/api/incidents/board", headers=officers["A"]).json()["unresolved"][0]
    assert board["dispatch"]["status"] == "accepted" and board["dispatch"]["my_center_status"] == "superseded"

    # The citizen learns which centre is coming.
    notifications = client.get("/api/citizen/notifications", headers=citizen).json()["items"]
    assert any(item["kind"] == "help_dispatched" and "Centre B" in item["message"] for item in notifications)
    assert client.get(f"/api/citizen/incidents/{incident}", headers=citizen).json()["help"]["center_name"] == "Centre B"

    # Resolving closes the remaining offers.
    assert client.post(f"/api/incidents/{incident}/resolve", json={"password": "a-unique-admin-password"}, headers=admin).status_code == 200


def test_declines_escalate_to_next_centres_then_everyone(api):
    client, _application = api
    register_citizen(client)
    admin, centers, officers = dispatch_setup(client)
    unassigned = make_officer(client, admin, "floating@police.example", None)
    incident = send_crash(client, "alert-escalate", ["KA01AB1234"])
    assert incident not in dispatch_ids(client, unassigned)

    for name in "ABCD":
        assert client.post(f"/api/incidents/{incident}/dispatch/decline", headers=officers[name]).status_code == 200
    # Everyone near declined: the next-nearest centres are asked.
    assert incident in dispatch_ids(client, officers["E"]) and incident in dispatch_ids(client, officers["F"])
    for name in "EF":
        client.post(f"/api/incidents/{incident}/dispatch/decline", headers=officers[name])
    # No centre left: every officer is alerted, and any centre can take it, including one never asked.
    assert incident in dispatch_ids(client, unassigned)
    extra_center = client.post("/api/admin/centers", json={"name": "Centre G", "latitude": 14.5, "longitude": 77.6}, headers=admin).json()
    officer_g = make_officer(client, admin, "officerg@police.example", extra_center["id"])
    accepted = client.post(f"/api/incidents/{incident}/dispatch/accept", headers=officer_g)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["dispatch"]["accepted_center"]["name"] == "Centre G"
    assert client.post(f"/api/incidents/{incident}/dispatch/accept", headers=officers["C"]).status_code == 409
    assert incident not in dispatch_ids(client, unassigned)


def test_citizen_minor_or_false_alarm_answer_is_saved_and_sent_to_authorities(api):
    client, _application = api
    citizen = register_citizen(client)
    admin = login(client, "admin@test.example", "a-unique-admin-password")
    minor = send_crash(client, "alert-minor", ["KA01AB1234"])
    old_app = send_crash(client, "alert-old", ["KA01AB1234"])

    ticket = client.post("/api/auth/websocket-ticket", headers=admin).json()["ticket"]
    with client.websocket_connect(f"/ws/live-cameras?ticket={ticket}") as live:
        answer = client.post(f"/api/citizen/incidents/{minor}/confirm", json={"outcome": "minor_ok"}, headers=citizen)
        assert answer.status_code == 200, answer.text
        assert answer.json()["outcome"] == "minor_ok" and answer.json()["accident_occurred"] is True
        event = live.receive_json()
        while event.get("type") != "citizen_crash_confirmation":
            event = live.receive_json()
    assert event["outcome"] == "minor_ok" and event["citizen_name"] == "Aarav Sharma"
    assert event["citizen_reports"]["minor_ok"] == 1

    detail = client.get(f"/api/incidents/{minor}", headers=admin).json()
    assert detail["citizen_reports"]["latest"]["outcome"] == "minor_ok"
    assert client.get(f"/api/citizen/incidents/{minor}", headers=citizen).json()["response"]["outcome"] == "minor_ok"

    # Older app versions still send only accident_occurred.
    legacy = client.post(f"/api/citizen/incidents/{old_app}/confirm", json={"accident_occurred": False}, headers=citizen)
    assert legacy.json()["outcome"] == "false_alarm"
    assert client.get(f"/api/incidents/{old_app}", headers=admin).json()["citizen_reports"]["false_alarm"] == 1
    assert client.post(f"/api/citizen/incidents/{old_app}/confirm", json={}, headers=citizen).status_code == 422
