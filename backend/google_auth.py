"""Google Sign-In: verifies the ID token the app gets from Google, without extra dependencies.

The app signs in with Google on the phone and sends the resulting ID token here. The token is a
JWT signed by Google; it is checked against Google's published keys, the expected client IDs
(`GOOGLE_CLIENT_IDS`), the issuer and expiry, and the email must be verified by Google.
"""

import os
from typing import Any

import jwt

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"
GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}

_jwks_client: jwt.PyJWKClient | None = None


class GoogleTokenError(ValueError):
    pass


def client_ids() -> list[str]:
    """OAuth client IDs whose tokens are accepted (the web client ID the app is configured with)."""
    raw = os.getenv("GOOGLE_CLIENT_IDS", "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def google_sign_in_enabled() -> bool:
    return bool(client_ids())


def verify_id_token(token: str) -> dict[str, Any]:
    """Returns the verified claims (email, name, sub, ...) or raises GoogleTokenError. Blocking (fetches keys)."""
    audiences = client_ids()
    if not audiences:
        raise GoogleTokenError("Google sign-in is not configured on this server.")
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = jwt.PyJWKClient(GOOGLE_CERTS_URL, cache_keys=True, lifespan=3600)
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=audiences,
            options={"require": ["exp", "iat", "iss", "aud", "sub"]},
            leeway=60,
        )
    except jwt.PyJWKClientError as error:
        raise GoogleTokenError("Could not check the Google sign-in with Google's servers. Try again.") from error
    except jwt.PyJWTError as error:
        raise GoogleTokenError("The Google sign-in could not be verified. Try again.") from error
    if claims.get("iss") not in GOOGLE_ISSUERS:
        raise GoogleTokenError("The Google sign-in was not issued by Google.")
    if not isinstance(claims.get("email"), str) or claims.get("email_verified") not in (True, "true"):
        raise GoogleTokenError("Your Google account email is not verified.")
    return claims


# ---- Driving route for the responder map (Google Routes API, server-side key) ----

ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes"


def routes_api_key() -> str:
    return os.getenv("GOOGLE_ROUTES_API_KEY", "").strip()


def compute_driving_route(origin: tuple[float, float], destination: tuple[float, float]) -> dict[str, Any]:
    """Returns {encoded_polyline, distance_m, duration_s}. Blocking; raises RuntimeError on failure."""
    import json
    import urllib.error
    import urllib.request

    key = routes_api_key()
    if not key:
        raise RuntimeError("Driving routes are not configured on this server.")
    body = json.dumps({
        "origin": {"location": {"latLng": {"latitude": origin[0], "longitude": origin[1]}}},
        "destination": {"location": {"latLng": {"latitude": destination[0], "longitude": destination[1]}}},
        "travelMode": "DRIVE",
        "routingPreference": "TRAFFIC_AWARE",
    }).encode()
    request = urllib.request.Request(
        ROUTES_URL,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Goog-Api-Key": key,
            "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode())
    except (urllib.error.URLError, TimeoutError, ValueError) as error:
        raise RuntimeError("Could not get a driving route from Google.") from error
    routes = payload.get("routes") or []
    if not routes:
        raise RuntimeError("Google found no driving route to this location.")
    route = routes[0]
    duration = str(route.get("duration", "0s")).rstrip("s")
    return {
        "encoded_polyline": route.get("polyline", {}).get("encodedPolyline", ""),
        "distance_m": int(route.get("distanceMeters", 0)),
        "duration_s": int(float(duration or 0)),
    }
